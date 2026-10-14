import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

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
  /**
   * Namespace de PID do dono (inode de /proc/self/ns/pid; ausente fora do
   * Linux). Um processo em sandbox com `--unshare-pid` vê o pid de quem está
   * fora como inexistente; sem comparar o namespace, ele julgaria abandonado o
   * lock de um dono vivo e entraria junto.
   */
  pidNamespace?: string;
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
  pidNamespace?: string;
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
  const configured = env.E2E_FIXTURE_LOCK_DIR;
  if (configured) {
    // Relativo seria resolvido pelo cwd de cada worker, e cada worktree teria
    // o próprio diretório: o lock deixaria de excluir sem nenhum erro.
    if (!isAbsolute(configured)) {
      throw new Error(
        `E2E_FIXTURE_LOCK_DIR precisa ser caminho absoluto: "${configured}"`,
      );
    }
    return configured;
  }
  const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
  }).trim();
  return join(resolve(cwd, commonDir), "e2e-fixture-locks");
}

export function fixtureLockPath(dir: string, key: string): string {
  return join(dir, `${key.replace(/[^A-Za-z0-9_-]/g, "_")}.lock`);
}

function currentPidNamespace(): string | undefined {
  try {
    return readlinkSync("/proc/self/ns/pid");
  } catch {
    return undefined;
  }
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
export function stealIfStillOwnedBy(
  path: string,
  staleToken: string,
  now: () => number,
): void {
  const stealPath = `${path}.steal`;
  const tmp = `${stealPath}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${process.pid}`);
  const takeStealLock = (): boolean => {
    try {
      linkSync(tmp, stealPath);
      return true;
    } catch (error) {
      if (errorCode(error) === "EEXIST") return false;
      throw error;
    }
  };
  const stealLockAbandoned = (): boolean => {
    try {
      return now() - statSync(stealPath).mtimeMs > STALE_STEAL_MS;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
  };
  let taken: boolean;
  try {
    taken = takeStealLock();
    // Lock de roubo abandonado (o ladrão morreu no meio): limpa e tenta uma vez
    // mais. Se dois processos limparem juntos, a releitura do token abaixo
    // continua impedindo que um apague o lock novo do outro.
    if (!taken && stealLockAbandoned()) {
      unlinkIfExists(stealPath);
      taken = takeStealLock();
    }
  } finally {
    unlinkSync(tmp);
  }
  if (!taken) return;
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
    pidNamespace: options.pidNamespace ?? currentPidNamespace(),
    cwd: process.cwd(),
    label: options.label,
    acquiredAt: "",
  };

  const isAbandoned = (current: FixtureLockOwner): boolean => {
    // O pid só diz algo quando os dois enxergam os mesmos processos.
    const samePidView =
      current.host === owner.host &&
      current.pidNamespace === owner.pidNamespace;
    if (samePidView && !isProcessAlive(current.pid)) return true;
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
      if (tryCreate(path, owner)) break;
      // Roubo que não abriu vaga (outro processo está no meio de um roubo, ou
      // ganhou a corrida pela vaga) cai na espera normal, com teto e sono.
      // Voltar direto ao topo giraria em CPU, sem teto, enquanto durasse.
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

// --- Uso por teste -------------------------------------------------------
//
// Fica aqui, e não no fixture do Playwright (fixture-lock-test.ts), para ser
// testável sem o runner: o fixture só liga isto ao `testInfo` e ao teardown.

// Teto da espera. Cobre um teste inteiro da outra execução (o maior timeout
// entre os specs que mutam fixture é 180s) com folga; passado isso, a falha
// nomeia o dono em vez de deixar uma asserção de banco acusar o produto.
export const DEFAULT_FIXTURE_LOCK_WAIT_MS = 5 * 60_000;

export function fixtureLockWaitMs(
  env: Readonly<Record<string, string | undefined>>,
): number {
  const raw = env.E2E_FIXTURE_LOCK_WAIT_MS;
  if (!raw) return DEFAULT_FIXTURE_LOCK_WAIT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`E2E_FIXTURE_LOCK_WAIT_MS inválido: "${raw}"`);
  }
  return parsed;
}

/** A parte do `TestInfo` do Playwright de que o holder precisa. */
export interface TestTimeoutInfo {
  timeout: number;
  setTimeout: (timeout: number) => void;
  titlePath: string[];
}

export interface FixtureLockHolderOptions {
  dir: string;
  waitMs: number;
  onWait?: (key: string, owner: FixtureLockOwner | null) => void;
  acquire?: typeof acquireFixtureLock;
}

export function createFixtureLockHolder(
  testInfo: TestTimeoutInfo,
  options: FixtureLockHolderOptions,
): { hold: (key: string) => Promise<void>; releaseAll: () => void } {
  const acquire = options.acquire ?? acquireFixtureLock;
  const held = new Map<string, HeldFixtureLock>();

  const hold = async (key: string) => {
    // O lock não é reentrante: a segunda tentativa esperaria pela primeira, do
    // próprio teste, até o teto. Melhor dizer logo.
    if (held.has(key)) {
      throw new Error(`holdFixtureLock("${key}") chamado duas vezes no mesmo teste`);
    }
    // `setTimeout` do Playwright fixa o orçamento TOTAL do teste, contado do
    // início. Sem abrir espaço antes de esperar, uma espera maior que o
    // restante do orçamento morreria em "Test timeout exceeded", sem o nome do
    // dono; com ele, quem dispara primeiro é o teto do lock, com a mensagem.
    // Obtido o lock, o orçamento volta a ser o original mais a espera real.
    // Timeout 0 é "sem limite" e fica como está.
    const base = testInfo.timeout;
    if (base > 0) testInfo.setTimeout(base + options.waitMs);
    const lock = await acquire(key, {
      dir: options.dir,
      label: testInfo.titlePath.join(" › "),
      waitMs: options.waitMs,
      onWait: (owner) => options.onWait?.(key, owner),
    });
    held.set(key, lock);
    if (base > 0) testInfo.setTimeout(base + lock.waitedMs);
  };

  const releaseAll = () => {
    for (const lock of [...held.values()].reverse()) lock.release();
    held.clear();
  };

  return { hold, releaseAll };
}
