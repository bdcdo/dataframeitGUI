import { spawn, type ChildProcess } from "node:child_process";
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

// Todo processo que um teste sobe, para o afterEach derrubar o que sobrou. Sem
// isso, um teste que falha antes de criar o arquivo de liberacao deixava o laco
// de espera do dono rodando para sempre, depois de o diretorio ja ter sumido.
const subidos: ChildProcess[] = [];

interface Execucao {
  pid: number;
  stderr: () => string;
  // Fecha a ponta de leitura do stderr do script, como quando o pre-commit que
  // le a saida do hook morre antes dele.
  fecharStderr: () => void;
  fim: Promise<number>;
}

// Variavel com valor `undefined` sai do ambiente do filho: o spawn a omite.
function executar(
  comando: string[],
  env: Record<string, string | undefined>,
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
  subidos.push(filho);
  filho.stderr.on("data", (parte: Buffer) => {
    stderr += parte.toString();
  });
  const fim = new Promise<number>((resolver, rejeitar) => {
    filho.on("error", rejeitar);
    filho.on("close", (codigo) => resolver(codigo ?? -1));
  });
  return {
    pid: filho.pid!,
    stderr: () => stderr,
    fecharStderr: () => filho.stderr.destroy(),
    fim,
  };
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
    if (existsSync(dir)) writeFileSync(liberar, "");
    for (const filho of subidos.splice(0)) {
      try {
        // `detached` pos cada um no proprio grupo, e o sinal vai ao grupo, nao
        // ao lider: quando o script morre antes do comando, o comando continua
        // no grupo, e checar so o lider o deixaria vivo.
        process.kill(-filho.pid!, "SIGKILL");
      } catch {
        // Grupo ja vazio.
      }
    }
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
  // Sem E2E_LOCK_FILE, a trava fica sob o $HOME e ignora $XDG_CACHE_HOME, que
  // um ambiente define e outro nao: com caminhos diferentes, duas execucoes
  // teriam cada uma a sua trava.
  it("trava default fica sob o HOME, nao sob XDG_CACHE_HOME", async () => {
    const home = join(dir, "home");
    const xdg = join(dir, "xdg");
    const execucao = executar(
      ["true"],
      { ...env, E2E_LOCK_FILE: undefined, HOME: home, XDG_CACHE_HOME: xdg },
      dir,
    );
    expect(await execucao.fim).toBe(0);
    expect(
      existsSync(join(home, ".cache", "dataframeitGUI", "pre-push-e2e.lock")),
    ).toBe(true);
    expect(existsSync(xdg)).toBe(false);
  });

  // Esvaziar a identificacao e arrumacao: se o arquivo sumiu junto com o
  // diretorio, o script ainda sai com o status do comando.
  it("trava apagada durante o comando nao troca o status", async () => {
    const lock = join(dir, "sub", "e2e.lock");
    const execucao = executar(
      ["bash", "-c", `rm -rf "$1"; exit 7`, "--", join(dir, "sub")],
      { ...env, E2E_LOCK_FILE: lock },
      dir,
    );
    expect(await execucao.fim).toBe(7);
    expect(existsSync(join(dir, "sub"))).toBe(false);
  });

  it("dono esvazia a identificacao ao sair", async () => {
    const execucao = executar(["true"], env, dir);
    expect(await execucao.fim).toBe(0);
    expect(readFileSync(env.E2E_LOCK_FILE, "utf8")).toBe("");
  });

  it("aviso espera o dono novo se identificar em vez de sair vazio", async () => {
    // O dono toma a trava e so grava quem e meio segundo depois, como o script
    // faz entre o flock e o printf.
    const segurando = join(dir, "segurando");
    const dono = spawn(
      "flock",
      [
        env.E2E_LOCK_FILE,
        "bash",
        "-c",
        `touch "$1"; sleep 0.5; echo dono-tardio > "$3"; while [ ! -e "$2" ]; do sleep 0.05; done`,
        "--",
        segurando,
        liberar,
        env.E2E_LOCK_FILE,
      ],
      { stdio: "ignore", detached: true },
    );
    subidos.push(dono);
    await esperarAte(() => existsSync(segurando), "dono segurar");
    const b = executar(["true"], { ...env, E2E_LOCK_WAIT_SECONDS: "0" }, dir);
    expect(await b.fim).toBe(1);
    expect(b.stderr()).toMatch(/segura a trava do E2E: dono-tardio/);
  }, 20_000);

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
    subidos.push(dono);
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

  it.each(["dez", "10x"])(
    "recusa teto de espera que nao e inteiro (%s)",
    async (teto) => {
      const execucao = executar(
        ["true"],
        { ...env, E2E_LOCK_WAIT_SECONDS: teto },
        dir,
      );
      expect(await execucao.fim).toBe(2);
    },
  );

  it("sem comando e erro de uso, e nao toma a trava", async () => {
    const execucao = executar([], env, dir);
    expect(await execucao.fim).toBe(2);
    expect(existsSync(env.E2E_LOCK_FILE)).toBe(false);
  });

  it("cria o diretorio da trava quando ele nao existe", async () => {
    const execucao = executar(
      ["true"],
      { ...env, E2E_LOCK_FILE: join(dir, "nao", "existe", "e2e.lock") },
      dir,
    );
    expect(await execucao.fim).toBe(0);
  });

  // Um sinal que chega ao script (terminal fechado, `timeout`, timeout da
  // ferramenta de um agente) nao pode soltar a trava com o comando vivo: o
  // proximo pre-push subiria o Playwright na porta que o anterior ainda ocupa.
  it.each([
    ["TERM so no script", "SIGTERM", false],
    ["HUP no grupo inteiro", "SIGHUP", true],
    ["INT no grupo inteiro", "SIGINT", true],
  ] as const)(
    "%s: a trava dura ate o comando sair",
    async (_rotulo, sinal, noGrupo) => {
      // O comando trata o sinal como o Playwright: desmonta e so sai quando o
      // arquivo de liberacao aparece. Um filho bash so consegue tratar o sinal
      // se o script nao o deixou ignorado: o bash nao instala trap para sinal
      // que ja chega ignorado.
      const comando = [
        "bash",
        "-c",
        `trap 'echo sinal-a >> "$1"' TERM HUP INT; echo "inicio-a" >> "$1"; while [ ! -e "$2" ]; do sleep 0.05; done; echo "fim-a" >> "$1"`,
        "--",
        log,
        liberar,
      ];
      const a = executar(comando, env, dir);
      await esperarAte(() => ordem().includes("inicio-a"), "a comecar");

      process.kill(noGrupo ? -a.pid : a.pid, sinal);
      if (noGrupo) {
        await esperarAte(() => ordem().includes("sinal-a"), "a receber");
      }

      const b = executar(["true"], { ...env, E2E_LOCK_WAIT_SECONDS: "0" }, dir);
      expect(await b.fim).toBe(1);

      writeFileSync(liberar, "");
      await a.fim;
      expect(ordem()).toContain("fim-a");
      expect(a.stderr()).toContain(`recebeu ${sinal}`);
    },
    20_000,
  );

  // O sinal que chega ao script costuma derrubar tambem quem le o stderr dele (o
  // pre-commit, num terminal fechado). Escrever o aviso final num pipe sem
  // leitor daria SIGPIPE, e o script morreria por ele em vez de sair com o
  // status do comando.
  it("aviso final sem leitor no stderr nao troca o status do comando", async () => {
    const comando = [
      "bash",
      "-c",
      `echo "inicio-a" >> "$1"; while [ ! -e "$2" ]; do sleep 0.05; done; exit 5`,
      "--",
      log,
      liberar,
    ];
    const a = executar(comando, env, dir);
    await esperarAte(() => ordem().includes("inicio-a"), "a comecar");

    a.fecharStderr();
    process.kill(a.pid, "SIGTERM");
    writeFileSync(liberar, "");
    expect(await a.fim).toBe(5);
  });
});
