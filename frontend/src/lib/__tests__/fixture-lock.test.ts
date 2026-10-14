import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireFixtureLock,
  defaultFixtureLockDir,
  fixtureLockPath,
  FixtureLockTimeoutError,
  type FixtureLockOwner,
} from "../../../e2e/fixture-lock";

const MODULE_PATH = resolve(__dirname, "../../../e2e/fixture-lock.ts");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fixture-lock-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeForeignLock(owner: Partial<FixtureLockOwner>): string {
  const path = fixtureLockPath(dir, "projeto");
  writeFileSync(
    path,
    JSON.stringify({
      token: "token-alheio",
      pid: 999_999,
      host: hostname(),
      cwd: "/outra/worktree",
      label: "teste alheio",
      acquiredAt: new Date().toISOString(),
      ...owner,
    }),
  );
  return path;
}

describe("acquireFixtureLock", () => {
  it("cria o lock com o dono e o apaga ao liberar", async () => {
    const lock = await acquireFixtureLock("projeto", {
      dir,
      label: "spec › teste",
      waitMs: 0,
    });
    const owner = JSON.parse(readFileSync(lock.path, "utf8")) as FixtureLockOwner;
    expect(owner).toMatchObject({ pid: process.pid, label: "spec › teste" });
    // Livre, entra na primeira tentativa: o que sobra é o custo do I/O.
    expect(lock.waitedMs).toBeLessThan(500);

    lock.release();
    expect(existsSync(lock.path)).toBe(false);
  });

  it("segunda execução espera a primeira liberar e então entra", async () => {
    const first = await acquireFixtureLock("projeto", {
      dir,
      label: "primeira",
      waitMs: 0,
    });
    const waitedFor: (FixtureLockOwner | null)[] = [];
    const second = acquireFixtureLock("projeto", {
      dir,
      label: "segunda",
      waitMs: 5_000,
      pollMs: 10,
      onWait: (owner) => waitedFor.push(owner),
    });
    setTimeout(first.release, 100);

    const lock = await second;
    expect(lock.waitedMs).toBeGreaterThanOrEqual(80);
    // Avisa uma vez só, com o dono que está segurando.
    expect(waitedFor).toHaveLength(1);
    expect(waitedFor[0]?.label).toBe("primeira");
    lock.release();
  });

  it("estourada a espera, falha nomeando o dono e o arquivo", async () => {
    const first = await acquireFixtureLock("projeto", {
      dir,
      label: "compare › veredito",
      waitMs: 0,
    });

    const error = await acquireFixtureLock("projeto", {
      dir,
      label: "segunda",
      waitMs: 50,
      pollMs: 10,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FixtureLockTimeoutError);
    const message = (error as Error).message;
    expect(message).toContain('"compare › veredito"');
    expect(message).toContain(`pid ${process.pid}`);
    expect(message).toContain(first.path);
    // O lock do dono continua lá: quem desiste não apaga nada.
    expect(existsSync(first.path)).toBe(true);
    first.release();
  });

  it("toma o lock de um processo morto nesta máquina", async () => {
    writeForeignLock({ pid: 4242 });
    const lock = await acquireFixtureLock("projeto", {
      dir,
      label: "nova",
      waitMs: 0,
      isProcessAlive: (pid) => pid !== 4242,
    });
    expect(
      (JSON.parse(readFileSync(lock.path, "utf8")) as FixtureLockOwner).label,
    ).toBe("nova");
    lock.release();
  });

  it("não toma o lock de processo vivo antes de maxHoldMs", async () => {
    writeForeignLock({ pid: 4242 });
    await expect(
      acquireFixtureLock("projeto", {
        dir,
        label: "nova",
        waitMs: 30,
        pollMs: 10,
        isProcessAlive: () => true,
      }),
    ).rejects.toBeInstanceOf(FixtureLockTimeoutError);
  });

  it("de outra máquina, só toma depois de maxHoldMs", async () => {
    const acquiredAt = Date.parse("2026-10-14T12:00:00Z");
    writeForeignLock({
      host: "outra-maquina",
      acquiredAt: new Date(acquiredAt).toISOString(),
    });
    const alive = () => false;

    await expect(
      acquireFixtureLock("projeto", {
        dir,
        label: "nova",
        waitMs: 0,
        maxHoldMs: 60_000,
        now: () => acquiredAt + 30_000,
        isProcessAlive: alive,
      }),
    ).rejects.toBeInstanceOf(FixtureLockTimeoutError);

    const lock = await acquireFixtureLock("projeto", {
      dir,
      label: "nova",
      waitMs: 0,
      maxHoldMs: 60_000,
      now: () => acquiredAt + 61_000,
      isProcessAlive: alive,
    });
    lock.release();
  });

  it("liberar um lock já tomado por outro não apaga o lock do outro", async () => {
    const lock = await acquireFixtureLock("projeto", {
      dir,
      label: "antiga",
      waitMs: 0,
    });
    const path = writeForeignLock({ token: "token-novo" });

    lock.release();
    expect(existsSync(path)).toBe(true);
  });

  it("libera na saída do processo e desliga o gancho ao liberar", async () => {
    const before = process.listenerCount("exit");
    const lock = await acquireFixtureLock("projeto", {
      dir,
      label: "x",
      waitMs: 0,
    });
    expect(process.listenerCount("exit")).toBe(before + 1);
    lock.release();
    expect(process.listenerCount("exit")).toBe(before);
  });

  // A propriedade que importa, medida entre processos de verdade: nenhum par
  // de processos fica dentro da seção crítica ao mesmo tempo. Dentro dela cada
  // filho cria um marcador com "wx"; se já existe, outro processo está lá
  // dentro, e o filho registra a sobreposição em vez de confiar em relógio.
  it("exclui processos concorrentes da seção crítica", async () => {
    const childScript = join(dir, "child.mjs");
    writeFileSync(
      childScript,
      `
import { appendFileSync, openSync, closeSync, unlinkSync } from "node:fs";
const [modulePath, lockDir, logPath, marker, rounds] = process.argv.slice(2);
const { acquireFixtureLock } = await import(modulePath);
for (let i = 0; i < Number(rounds); i++) {
  const lock = await acquireFixtureLock("projeto", { dir: lockDir, label: "filho", waitMs: 30000, pollMs: 2 });
  let inside = true;
  try { closeSync(openSync(marker, "wx")); } catch { inside = false; }
  appendFileSync(logPath, inside ? "ok\\n" : "SOBREPOSTO\\n");
  await new Promise((done) => setTimeout(done, 5));
  if (inside) unlinkSync(marker);
  lock.release();
}
`,
    );
    const lockDir = join(dir, "locks");
    const logPath = join(dir, "log");
    const marker = join(dir, "dentro");
    writeFileSync(logPath, "");
    const run = promisify(execFile);
    const children = 4;
    const rounds = 8;

    await Promise.all(
      Array.from({ length: children }, () =>
        run(process.execPath, [
          "--no-warnings",
          childScript,
          MODULE_PATH,
          lockDir,
          logPath,
          marker,
          String(rounds),
        ]),
      ),
    );

    const entries = readFileSync(logPath, "utf8").trim().split("\n");
    expect(entries).toHaveLength(children * rounds);
    expect(entries.filter((e) => e !== "ok")).toEqual([]);
  }, 30_000);
});

describe("defaultFixtureLockDir", () => {
  it("respeita E2E_FIXTURE_LOCK_DIR", () => {
    expect(defaultFixtureLockDir({ E2E_FIXTURE_LOCK_DIR: "/x/y" })).toBe("/x/y");
  });

  it("fica no diretório comum do Git, compartilhado entre worktrees", () => {
    expect(defaultFixtureLockDir({}, __dirname)).toMatch(
      /\.git\/e2e-fixture-locks$/,
    );
  });
});
