import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

// Lock de projeto fixture entre execuções do Playwright na MESMA máquina.
//
// Os specs que mutam um projeto fixture no Supabase remoto (reset com a service
// key, escrita pela UI, asserção no banco) assumem o projeto só para si do
// reset até a última leitura. `mode: "default"` serializa os testes dentro de
// UMA execução; duas execuções simultâneas (dois `git push` em worktrees
// diferentes, ou um `playwright test` manual ao lado do pre-push) não se
// enxergam, e o reset de uma apaga o que a outra acabou de gravar: a vítima vê
// o toast de sucesso e depois uma asserção de banco vazia, que acusa o produto
// em vez da corrida.
//
// O lock é um arquivo por projeto, criado de forma atômica. Quem não consegue
// espera; passado o teto, falha nomeando o dono. Não cobre outra máquina: duas
// máquinas com o mesmo `.env.e2e` continuam podendo colidir.

export interface FixtureLockOwner {
  token: string;
  pid: number;
  host: string;
  cwd: string;
  label: string;
  acquiredAt: string;
}

export interface FixtureLockOptions {
  dir: string;
  /** Quem segura o lock, para a mensagem de quem espera (ex.: título do teste). */
  label: string;
  waitMs: number;
  pollMs?: number;
  /**
   * Idade a partir da qual um lock é considerado abandonado mesmo com o
   * processo dono vivo (pid reaproveitado, worker travado em depuração).
   */
  maxHoldMs?: number;
  /** Chamado uma vez, na primeira vez que o lock está ocupado. */
  onWait?: (owner: FixtureLockOwner | null) => void;
  now?: () => number;
  isProcessAlive?: (pid: number) => boolean;
}

export interface HeldFixtureLock {
  path: string;
  waitedMs: number;
  release: () => void;
}

const DEFAULT_POLL_MS = 500;
// Bem acima do maior timeout de teste dos specs que mutam fixture (180s): um
// dono vivo nunca segura por tanto tempo, então chegar aqui é abandono.
const DEFAULT_MAX_HOLD_MS = 15 * 60_000;
// O lock de roubo só existe por milissegundos; mais velho que isto, o processo
// que o criou morreu no meio do roubo.
const STALE_STEAL_MS = 10_000;

export class FixtureLockTimeoutError extends Error {
  readonly owner: FixtureLockOwner | null;

  constructor(message: string, owner: FixtureLockOwner | null) {
    super(message);
    this.name = "FixtureLockTimeoutError";
    this.owner = owner;
  }
}

/**
 * Diretório comum a todas as worktrees do repositório. O `.git` comum é
 * gravável em qualquer lugar em que o próprio `git push` funciona, o que não
 * vale para `$TMPDIR` (que sandboxes trocam por sessão, e aí cada execução
 * teria o próprio diretório e o lock não excluiria nada).
 */
export function defaultFixtureLockDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd: string = __dirname,
): string {
  if (env.E2E_FIXTURE_LOCK_DIR) return env.E2E_FIXTURE_LOCK_DIR;
  const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
  }).trim();
  return join(resolve(cwd, commonDir), "e2e-fixture-locks");
}

export function fixtureLockPath(dir: string, key: string): string {
  return join(dir, `${key.replace(/[^A-Za-z0-9_-]/g, "_")}.lock`);
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: o processo existe, só não é nosso.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function readOwner(path: string): FixtureLockOwner | null {
  // Null cobre o lock que sumiu entre a tentativa e a leitura (o loop tenta de
  // novo) e o conteúdo ilegível. Este não nasce da criação por `link`, que
  // publica o arquivo completo; se aparecer, alguém escreveu ali à mão, e o
  // dono desconhecido nunca é julgado abandonado: o teste espera e falha com o
  // caminho do arquivo na mensagem.
  try {
    return JSON.parse(readFileSync(path, "utf8")) as FixtureLockOwner;
  } catch {
    return null;
  }
}

/**
 * Cria o lock já com o conteúdo completo: escreve num arquivo temporário e o
 * publica com `link`, que falha com EEXIST se o lock existe. Com
 * `open(..., "wx")` + `write` haveria uma janela em que outro processo leria o
 * lock vazio sem saber se é lixo ou lock nascendo.
 */
function tryCreate(path: string, owner: FixtureLockOwner): boolean {
  const tmp = `${path}.${owner.token}.tmp`;
  writeFileSync(tmp, JSON.stringify(owner));
  try {
    linkSync(tmp, path);
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  } finally {
    unlinkSync(tmp);
  }
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

/**
 * Apaga um lock abandonado sem apagar, por engano, o lock novo de outro
 * processo. Dois processos que viram o mesmo lock morto podem intercalar
 * assim: A apaga e recria; B, atrasado, apaga o lock NOVO de A, e os dois
 * passam a se achar donos. O lock de roubo serializa os roubos, e a releitura
 * do token dentro dele garante que só sai o lock que foi julgado morto.
 */
function stealIfStillOwnedBy(
  path: string,
  staleToken: string,
  now: () => number,
): void {
  const stealPath = `${path}.steal`;
  const stealOwner = `${process.pid}:${randomUUID()}`;
  const tmp = `${stealPath}.${randomUUID()}.tmp`;
  writeFileSync(tmp, stealOwner);
  try {
    linkSync(tmp, stealPath);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    try {
      if (now() - statSync(stealPath).mtimeMs > STALE_STEAL_MS) {
        unlinkIfExists(stealPath);
      }
    } catch (statError) {
      if (errorCode(statError) !== "ENOENT") throw statError;
    }
    return;
  } finally {
    unlinkSync(tmp);
  }
  try {
    if (readOwner(path)?.token === staleToken) unlinkIfExists(path);
  } finally {
    unlinkIfExists(stealPath);
  }
}

function describeOwner(owner: FixtureLockOwner | null): string {
  if (!owner) return "dono ilegível";
  return `"${owner.label}" (pid ${owner.pid} em ${owner.host}, ${owner.cwd}), desde ${owner.acquiredAt}`;
}

export async function acquireFixtureLock(
  key: string,
  options: FixtureLockOptions,
): Promise<HeldFixtureLock> {
  const now = options.now ?? Date.now;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const maxHoldMs = options.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
  const path = fixtureLockPath(options.dir, key);
  mkdirSync(options.dir, { recursive: true });

  const owner: FixtureLockOwner = {
    token: randomUUID(),
    pid: process.pid,
    host: hostname(),
    cwd: process.cwd(),
    label: options.label,
    acquiredAt: "",
  };

  const isAbandoned = (current: FixtureLockOwner): boolean => {
    if (current.host === owner.host && !isProcessAlive(current.pid)) return true;
    const acquiredAt = Date.parse(current.acquiredAt);
    return Number.isFinite(acquiredAt) && now() - acquiredAt > maxHoldMs;
  };

  const start = now();
  let warned = false;
  for (;;) {
    owner.acquiredAt = new Date(now()).toISOString();
    if (tryCreate(path, owner)) break;

    const current = readOwner(path);
    if (current && isAbandoned(current)) {
      stealIfStillOwnedBy(path, current.token, now);
      continue;
    }
    if (!warned) {
      warned = true;
      options.onWait?.(current);
    }
    const waited = now() - start;
    if (waited >= options.waitMs) {
      throw new FixtureLockTimeoutError(
        `Fixture E2E "${key}" ocupado por outra execução há ${Math.round(waited / 1000)}s: ` +
          `${describeOwner(current)}. Este teste apaga e regrava dados desse ` +
          "projeto no Supabase, e rodar junto apagaria os dados da outra " +
          "execução. Espere ela terminar; se ela não existe mais, apague " +
          `${path}.`,
        current,
      );
    }
    await new Promise((done) => setTimeout(done, pollMs));
  }

  const waitedMs = now() - start;
  const release = () => {
    process.removeListener("exit", release);
    // Só apaga o próprio lock: se ele foi julgado abandonado e roubado, o
    // arquivo agora é de outra execução.
    if (readOwner(path)?.token === owner.token) unlinkIfExists(path);
  };
  // Worker encerrado sem passar pelo teardown do fixture (Ctrl-C, erro fatal):
  // libera na saída. SIGKILL não passa por aqui, e é o pid morto que cobre.
  process.once("exit", release);
  return { path, waitedMs, release };
}
