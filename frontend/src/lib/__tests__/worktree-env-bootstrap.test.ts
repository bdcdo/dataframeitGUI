import { execFileSync, spawnSync } from "node:child_process";
import {
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
import { parse } from "dotenv";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
    Object.keys(
      parse(
        readFileSync(resolve(trackedFrontend, `${filename}.example`), "utf8"),
      ),
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
    for (const filename of envFiles) {
      expect(() => lstatSync(join(fixtureFrontend, filename))).toThrow();
    }
  });

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
    for (const filename of envFiles) {
      expect(() => lstatSync(join(fixtureFrontend, filename))).toThrow();
    }
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
