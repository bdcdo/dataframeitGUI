import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Contrato da trava de maquina do pre-push (scripts/e2e-lock.sh), que
// serializa o hook e2e-smoke entre worktrees. Os testes nao dependem de tempo: o
// dono da trava so solta quando o teste cria um arquivo de liberacao, entao a
// ordem observada e a da trava mesmo com a maquina carregada.

const script = resolve(process.cwd(), "scripts/e2e-lock.sh");

interface Execucao {
  stderr: () => string;
  fim: Promise<number>;
}

function executar(
  comando: string[],
  env: Record<string, string>,
  cwd: string,
): Execucao {
  let stderr = "";
  // Caminho absoluto do bash porque um dos testes zera o PATH. `detached`
  // abre sessao nova, sem terminal de controle: o aviso que o script manda ao
  // /dev/tty nao vaza para o terminal de quem roda a suite.
  const filho = spawn("/bin/bash", [script, ...comando], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  filho.stderr.on("data", (parte: Buffer) => {
    stderr += parte.toString();
  });
  const fim = new Promise<number>((resolver, rejeitar) => {
    filho.on("error", rejeitar);
    filho.on("close", (codigo) => resolver(codigo ?? -1));
  });
  return { stderr: () => stderr, fim };
}

async function esperarAte(condicao: () => boolean, rotulo: string) {
  const limite = Date.now() + 20_000;
  while (!condicao()) {
    if (Date.now() > limite) throw new Error(`nao aconteceu: ${rotulo}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("trava de maquina do E2E", () => {
  let dir: string;
  let env: Record<string, string>;
  let log: string;
  let liberar: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dataframeit-e2e-lock-"));
    log = join(dir, "ordem.log");
    liberar = join(dir, "liberar");
    env = {
      E2E_LOCK_FILE: join(dir, "e2e.lock"),
      E2E_LOCK_WAIT_SECONDS: "60",
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Registra o inicio, segura ate o arquivo de liberacao existir e registra o fim.
  function segurarAteLiberar(nome: string): string[] {
    return [
      "bash",
      "-c",
      `echo "inicio-${nome}" >> "$1"; while [ ! -e "$2" ]; do sleep 0.05; done; echo "fim-${nome}" >> "$1"`,
      "--",
      log,
      liberar,
    ];
  }

  function ordem(): string[] {
    return existsSync(log)
      ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
      : [];
  }

  it("segunda execucao espera a primeira terminar e diz por quem espera", async () => {
    const a = executar(segurarAteLiberar("a"), env, dir);
    await esperarAte(() => ordem().includes("inicio-a"), "a comecar");

    const b = executar(segurarAteLiberar("b"), env, dir);
    await esperarAte(() => b.stderr().includes("aguardando"), "b esperar");

    // Enquanto a segura, b nao comecou.
    expect(ordem()).toEqual(["inicio-a"]);
    // A mensagem identifica o dono pelo comando que ele roda.
    expect(b.stderr()).toMatch(/segura a trava do E2E: .*inicio-a/);

    writeFileSync(liberar, "");
    expect(await a.fim).toBe(0);
    expect(await b.fim).toBe(0);
    expect(ordem()).toEqual(["inicio-a", "fim-a", "inicio-b", "fim-b"]);
    expect(b.stderr()).toMatch(/trava obtida apos \d+s/);
  });

  it("espera que estoura o teto falha nomeando o dono", async () => {
    const a = executar(segurarAteLiberar("a"), env, dir);
    await esperarAte(() => ordem().includes("inicio-a"), "a comecar");

    const b = executar(["true"], { ...env, E2E_LOCK_WAIT_SECONDS: "0" }, dir);
    expect(await b.fim).toBe(1);
    expect(b.stderr()).toMatch(/continuou ocupada por 0s; dono: .*inicio-a/);
    expect(b.stderr()).toContain("SKIP=e2e-smoke git push");

    writeFileSync(liberar, "");
    expect(await a.fim).toBe(0);
  });

  it("devolve o status de saida do comando", async () => {
    const execucao = executar(["bash", "-c", "exit 7"], env, dir);
    expect(await execucao.fim).toBe(7);
  });

  // Quem chegasse entre a saida de um dono e a identificacao do seguinte lia o
  // nome do dono que ja tinha saido.
  it("dono esvazia a identificacao ao sair", async () => {
    const execucao = executar(["true"], env, dir);
    expect(await execucao.fim).toBe(0);
    expect(readFileSync(env.E2E_LOCK_FILE, "utf8")).toBe("");
  });

  it("dono que ainda nao se identificou nao vira nome inventado", async () => {
    // Segura a trava direto pelo flock, sem gravar nada: e o instante entre o
    // dono tomar a trava e escrever quem e.
    const segurando = join(dir, "segurando");
    const dono = spawn(
      "flock",
      [
        env.E2E_LOCK_FILE,
        "bash",
        "-c",
        `touch "$1"; while [ ! -e "$2" ]; do sleep 0.05; done`,
        "--",
        segurando,
        liberar,
      ],
      { stdio: "ignore", detached: true },
    );
    const fimDono = new Promise<number>((r) =>
      dono.on("close", (codigo) => r(codigo ?? -1)),
    );
    try {
      await esperarAte(() => existsSync(segurando), "dono segurar");
      const b = executar(["true"], { ...env, E2E_LOCK_WAIT_SECONDS: "0" }, dir);
      expect(await b.fim).toBe(1);
      expect(b.stderr()).toContain("o dono ainda nao gravou a identificacao");
    } finally {
      writeFileSync(liberar, "");
      await fimDono;
    }
    // Quem espera relê a identificação por até 2s em cada um dos dois avisos.
  }, 20_000);

  // O `next dev` que o Playwright sobe pode sobreviver a ele. Se o comando
  // herdasse o descritor da trava, esse orfao a seguraria para sempre.
  it("processo que sobrevive ao comando nao segura a trava", async () => {
    const pidFile = join(dir, "orfao.pid");
    const comOrfao = executar(
      [
        "bash",
        "-c",
        `sleep 60 >/dev/null 2>&1 & echo $! > "$1"`,
        "--",
        pidFile,
      ],
      env,
      dir,
    );
    expect(await comOrfao.fim).toBe(0);
    const orfao = Number(readFileSync(pidFile, "utf8"));
    try {
      const seguinte = executar(
        ["true"],
        { ...env, E2E_LOCK_WAIT_SECONDS: "0" },
        dir,
      );
      expect(await seguinte.fim).toBe(0);
    } finally {
      process.kill(orfao);
    }
  });

  it("sem flock falha fechado em vez de rodar sem trava", async () => {
    // PATH vazio: `command -v flock` nao acha nada, e o check vem antes de
    // qualquer outro binario externo.
    const execucao = executar(["true"], { ...env, PATH: "/nonexistent" }, dir);
    expect(await execucao.fim).toBe(1);
    expect(execucao.stderr()).toContain("flock ausente");
  });

  it("recusa teto de espera que nao e inteiro", async () => {
    const execucao = executar(
      ["true"],
      { ...env, E2E_LOCK_WAIT_SECONDS: "dez" },
      dir,
    );
    expect(await execucao.fim).toBe(2);
  });
});
