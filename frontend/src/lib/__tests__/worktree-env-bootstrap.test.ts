import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requiredEnvironmentNamesForFile } from "../../../scripts/worktree-env/env-contract.mjs";

const trackedFrontend = process.cwd();
const envFiles = [".env.local", ".env.e2e"] as const;
const isolatedGitEnvironment = { ...process.env };
for (const name of [
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_WORK_TREE",
]) {
  delete isolatedGitEnvironment[name];
}

const requiredByFile = Object.fromEntries(
  envFiles.map((filename) => [
    filename,
    requiredEnvironmentNamesForFile(
      resolve(trackedFrontend, `${filename}.example`),
    ),
  ]),
) as Record<(typeof envFiles)[number], string[]>;

describe("bootstrap de ambiente para worktrees", () => {
  let temporaryRoot: string;
  let repository: string;
  let fixtureFrontend: string;
  let sourceFrontend: string;
  let bootstrap: string;

  beforeEach(() => {
    temporaryRoot = mkdtempSync(join(tmpdir(), "dataframeit-worktree-env-"));
    repository = join(temporaryRoot, "repository");
    fixtureFrontend = join(repository, "frontend");
    sourceFrontend = join(temporaryRoot, "source-frontend");
    bootstrap = join(
      fixtureFrontend,
      "scripts",
      "worktree-env",
      "bootstrap.sh",
    );

    mkdirSync(join(fixtureFrontend, "scripts", "worktree-env"), {
      recursive: true,
    });
    mkdirSync(sourceFrontend, { recursive: true });
    copyFileSync(
      resolve(trackedFrontend, "scripts/worktree-env/bootstrap.sh"),
      bootstrap,
    );
    for (const filename of ["bootstrap.mjs", "env-contract.mjs"]) {
      copyFileSync(
        resolve(trackedFrontend, "scripts/worktree-env", filename),
        join(fixtureFrontend, "scripts/worktree-env", filename),
      );
    }
    copyFileSync(
      resolve(trackedFrontend, ".env.local.example"),
      join(fixtureFrontend, ".env.local.example"),
    );
    copyFileSync(
      resolve(trackedFrontend, ".env.e2e.example"),
      join(fixtureFrontend, ".env.e2e.example"),
    );
    copyFileSync(
      resolve(trackedFrontend, ".gitignore"),
      join(fixtureFrontend, ".gitignore"),
    );
  });

  afterEach(() => {
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  function writeCompleteSource(omitted: ReadonlySet<string> = new Set()): void {
    for (const filename of envFiles) {
      const content = requiredByFile[filename]
        .filter((name) => !omitted.has(name))
        .map((name) => `${name}=TOP-SECRET-${name}`)
        .join("\n");
      writeFileSync(join(sourceFrontend, filename), `${content}\n`);
    }
  }

  function runBootstrap(source = sourceFrontend) {
    return spawnSync("bash", [bootstrap, "--source", source], {
      cwd: repository,
      encoding: "utf8",
    });
  }

  function appendSourceLine(filename: (typeof envFiles)[number], line: string) {
    appendFileSync(join(sourceFrontend, filename), `${line}\n`);
  }

  function expectNoDestinations() {
    for (const filename of envFiles) {
      expect(() => lstatSync(join(fixtureFrontend, filename))).toThrow();
    }
  }

  it("cria os dois symlinks sem copiar os arquivos", () => {
    writeCompleteSource();

    const result = runBootstrap();

    expect(result.status).toBe(0);
    for (const filename of envFiles) {
      const destination = join(fixtureFrontend, filename);
      expect(lstatSync(destination).isSymbolicLink()).toBe(true);
      expect(readlinkSync(destination)).toBe(join(sourceFrontend, filename));
    }
  });

  it("falha sem criar destinos quando a fonte não existe", () => {
    const result = runBootstrap(join(temporaryRoot, "missing-source"));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("fonte inexistente");
    expectNoDestinations();
  });

  // Root ignora o chmod 000 abaixo: a leitura da fonte teria sucesso e o caso
  // afirmaria um EACCES que nunca acontece. Pular é honesto — o caso não é
  // observável para esse usuário.
  it.skipIf(process.getuid?.() === 0)(
    "distingue erro de permissão de uma fonte ausente",
    () => {
      writeCompleteSource();
      chmodSync(sourceFrontend, 0o000);

      let result: ReturnType<typeof runBootstrap>;
      try {
        result = runBootstrap();
      } finally {
        chmodSync(sourceFrontend, 0o700);
      }

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("EACCES");
      expect(result.stderr).not.toContain("fonte sem");
      expectNoDestinations();
    },
  );

  it("falha antes de criar o segundo destino quando um destino já existe", () => {
    writeCompleteSource();
    writeFileSync(join(fixtureFrontend, ".env.local"), "original-local\n");

    const result = runBootstrap();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("destino já existe: frontend/.env.local");
    expect(readFileSync(join(fixtureFrontend, ".env.local"), "utf8")).toBe(
      "original-local\n",
    );
    expect(() => lstatSync(join(fixtureFrontend, ".env.e2e"))).toThrow();
  });

  it("identifica somente o nome obrigatório ausente e não cria symlinks", () => {
    writeCompleteSource(new Set(["SUPABASE_SERVICE_ROLE_KEY"]));

    const result = runBootstrap();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(`${result.stdout}${result.stderr}`).not.toContain("TOP-SECRET");
    expectNoDestinations();
  });

  it("considera a última atribuição quando ela esvazia um valor", () => {
    writeCompleteSource();
    appendSourceLine(".env.local", "SUPABASE_SERVICE_ROLE_KEY=");

    const result = runBootstrap();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expectNoDestinations();
  });

  it("aceita a última atribuição quando ela preenche um valor", () => {
    writeCompleteSource(new Set(["SUPABASE_SERVICE_ROLE_KEY"]));
    appendSourceLine(
      ".env.local",
      "SUPABASE_SERVICE_ROLE_KEY=TOP-SECRET-final",
    );

    expect(runBootstrap().status).toBe(0);
  });

  it("remove comentário inline de valor não delimitado por aspas", () => {
    writeCompleteSource();
    appendSourceLine(".env.local", "SUPABASE_SERVICE_ROLE_KEY=# comentário");

    const result = runBootstrap();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("preserva cerquilha delimitada por aspas", () => {
    writeCompleteSource();
    appendSourceLine(".env.local", 'SUPABASE_SERVICE_ROLE_KEY="# valor"');

    expect(runBootstrap().status).toBe(0);
  });

  it("rejeita valor entre aspas composto somente por espaços", () => {
    writeCompleteSource();
    appendSourceLine(".env.local", 'SUPABASE_SERVICE_ROLE_KEY="   "');

    const result = runBootstrap();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("preserva todos os destinos preexistentes", () => {
    writeCompleteSource();
    writeFileSync(join(fixtureFrontend, ".env.local"), "keep-local\n");
    writeFileSync(join(fixtureFrontend, ".env.e2e"), "keep-e2e\n");

    const result = runBootstrap();

    expect(result.status).not.toBe(0);
    expect(readFileSync(join(fixtureFrontend, ".env.local"), "utf8")).toBe(
      "keep-local\n",
    );
    expect(readFileSync(join(fixtureFrontend, ".env.e2e"), "utf8")).toBe(
      "keep-e2e\n",
    );
  });

  it("mantém o status do Git limpo após o provisionamento", () => {
    writeCompleteSource();
    execFileSync("git", ["init", "--quiet"], {
      cwd: repository,
      env: isolatedGitEnvironment,
    });
    execFileSync("git", ["add", "."], {
      cwd: repository,
      env: isolatedGitEnvironment,
    });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Bootstrap Test",
        "-c",
        "user.email=bootstrap@example.com",
        "commit",
        "--quiet",
        "-m",
        "fixture",
      ],
      { cwd: repository, env: isolatedGitEnvironment },
    );

    expect(runBootstrap().status).toBe(0);
    expect(
      execFileSync("git", ["status", "--short"], {
        cwd: repository,
        encoding: "utf8",
        env: isolatedGitEnvironment,
      }),
    ).toBe("");
  });
});
