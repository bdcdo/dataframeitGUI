import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isolatedGitEnvironment, runGit } from "@/test-utils/isolated-git";

// Contrato do scripts/measure-gate-bump.sh, a receita versionada da medição
// pareada de PR que sobe ferramenta de gate (docs/CODE_QUALITY_TOOLING.md). O
// pre-commit e o uv são falsos (em measure-gate-bump-fakes/): o pre-commit roda o entry do gitleaks como se
// fosse o binário e acha todo token na forma `ghp_` + 36 alfanuméricos sob o
// diretório que recebe, e o uv registra com que lockfile e em que diretório
// cada comando rodou.

const script = fileURLToPath(new URL("../../../scripts/measure-gate-bump.sh", import.meta.url));
const realPreCommitConfig = fs.readFileSync(
  fileURLToPath(new URL("../../../../.pre-commit-config.yaml", import.meta.url)),
  "utf8",
);

// Montado em tempo de execução: um token literal neste arquivo reprovaria o
// próprio hook do gitleaks.
const fakeToken = (char: string) => `ghp_${char.repeat(36)}`;

const fakes = fileURLToPath(new URL("./measure-gate-bump-fakes/", import.meta.url));

function preCommitConfig(
  side: string,
  rev: string,
  { repo = "https://github.com/gitleaks/gitleaks", hooks = ["check-merge-conflict", "actionlint"] } = {},
) {
  const local = hooks.map((id) => `      - id: ${id}\n`).join("");
  return `# lado: ${side}\nrepos:\n  - repo: local\n    hooks:\n${local}  - repo: ${repo}\n    rev: ${rev}\n    hooks:\n      - id: gitleaks\n`;
}

let dir: string;
let repo: string;
let log: string;
let bin: string;
let base: string;

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
}

function commit(files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) write(file, content);
  runGit(["add", "-A"], repo);
  runGit(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qm", "c"], repo);
  return runGit(["rev-parse", "HEAD"], repo).trim();
}

function measure(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync("/bin/bash", [script, ...args], {
    cwd: repo,
    env: { ...isolatedGitEnvironment(), PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, ...env },
    encoding: "utf8",
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
  return { ...result, calls };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "measure-gate-bump-"));
  repo = path.join(dir, "repo");
  bin = path.join(dir, "bin");
  log = path.join(dir, "calls.log");
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  for (const fake of ["pre-commit", "uv"]) {
    fs.copyFileSync(path.join(fakes, fake), path.join(bin, fake));
    fs.chmodSync(path.join(bin, fake), 0o755);
  }
  runGit(["init", "-q"], repo);
  base = commit({
    ".pre-commit-config.yaml": preCommitConfig("antiga", "v1.0.0"),
    ".gitleaks.toml": "[extend]\nuseDefault = true\n",
    "versionado.txt": `token = "${fakeToken("a")}"\n`,
    "backend/pyproject.toml": "[project]\nname = 'x'\n",
    "backend/uv.lock": "lock-antiga",
    "backend/.python-version": "3.12\n",
  });
  commit({
    ".pre-commit-config.yaml": preCommitConfig("nova", "v2.0.0"),
    "backend/uv.lock": "lock-nova",
  });
  // Fora do git: o .env.local de verdade nunca entra na medição.
  write(".env.local", `TOKEN=${fakeToken("b")}\n`);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("measure-gate-bump.sh pre-commit", () => {
  it("mede a versão de cada lado sobre a árvore versionada, sem contar o canário", () => {
    const { status, stdout, stderr, calls } = measure(["pre-commit", base]);
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(calls).toEqual([
      "check-merge-conflict lado: antiga rev=v1.0.0",
      "actionlint lado: antiga rev=v1.0.0",
      "gitleaks gerada rev=v1.0.0",
      "check-merge-conflict lado: nova rev=v2.0.0",
      "actionlint lado: nova rev=v2.0.0",
      "gitleaks gerada rev=v2.0.0",
    ]);
    // Só o token versionado: o canário sai da conta e o .env.local não entra.
    expect(stdout).toContain("gitleaks v1.0.0 (antiga): 1 achado(s)");
    expect(stdout).toContain("gitleaks v2.0.0 (nova): 1 achado(s)");
  });

  // É o que `pre-commit run gitleaks --all-files` faz com o hook do repo: passa
  // sem escanear nada. A medição não pode ler isso como "0 achados".
  it("falha alto quando o gitleaks não lê a árvore", () => {
    const empty = measure(["pre-commit", base], { FAKE_GITLEAKS: "empty" });
    expect(empty.status).not.toBe(0);
    expect(empty.stderr).toContain("não achou o canário plantado");
    expect(empty.stdout).not.toContain("achado(s)");

    const noop = measure(["pre-commit", base], { FAKE_GITLEAKS: "noop" });
    expect(noop.status).not.toBe(0);
    expect(noop.stderr).toContain("não gravou o relatório");
  });

  it("falha alto quando o hook do gitleaks deixa de vir do repo do gitleaks", () => {
    commit({ ".pre-commit-config.yaml": preCommitConfig("nova", "v2.0.0", { repo: "local" }) });
    const { status, stderr } = measure(["pre-commit", base]);
    expect(status).not.toBe(0);
    expect(stderr).toContain("hook gitleaks fora do repo gitleaks/gitleaks");
  });

  // O `pre-commit run` de um hook que não existe sai com 1, como o de um hook
  // que achou problema: o resumo não pode registrar isso como medição.
  it("registra o hook ausente num dos lados como ausente, sem rodá-lo", () => {
    const antiga = commit({
      ".pre-commit-config.yaml": preCommitConfig("antiga", "v1.0.0", { hooks: ["check-merge-conflict"] }),
    });
    commit({ ".pre-commit-config.yaml": preCommitConfig("nova", "v2.0.0") });
    const { status, stdout, calls } = measure(["pre-commit", antiga]);
    expect(status).toBe(0);
    expect(calls.filter((call) => call.startsWith("actionlint"))).toEqual(["actionlint lado: nova rev=v2.0.0"]);
    expect(stdout).toContain("actionlint (antiga): ausente na config");
    expect(stdout).toContain("actionlint (nova): exit 0");
  });

  // O rev real é um SHA com a tag em `# frozen:` (#555): o hook roda o SHA, e o
  // resumo nomeia a tag.
  it("acha o rev do gitleaks na .pre-commit-config.yaml real do repo e rotula pela tag do # frozen:", () => {
    const pinned = realPreCommitConfig.match(
      /repo: https:\/\/github\.com\/gitleaks\/gitleaks\n\s+rev: ([0-9a-f]{40})\s+# frozen: (\S+)/,
    );
    expect(pinned).not.toBeNull();
    const [, sha, tag] = pinned!;
    const head = commit({ ".pre-commit-config.yaml": realPreCommitConfig });
    const { status, stdout, stderr, calls } = measure(["pre-commit", head]);
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(calls.filter((call) => call.startsWith("gitleaks"))).toEqual([
      `gitleaks gerada rev=${sha}`,
      `gitleaks gerada rev=${sha}`,
    ]);
    expect(stdout).toContain(`gitleaks ${tag} (${sha.slice(0, 9)}) (antiga): `);
    expect(stdout).toContain(`gitleaks ${tag} (${sha.slice(0, 9)}) (nova): `);
  });
});

describe("measure-gate-bump.sh uv", () => {
  // P é o projeto temporário do lado: o lockfile e a config ([tool.ruff],
  // [tool.mypy]) vêm de lá, e não do backend/ do worktree, onde os comandos
  // rodam. Nada de --fix, e nenhum cache gravado no worktree.
  it("roda ruff e mypy no backend com o lockfile e a config de cada lado, sem --fix", () => {
    const { status, stderr, calls } = measure(["uv", base]);
    expect(stderr).toBe("");
    expect(status).toBe(0);
    const runs = (lock: string) => [
      `sync ${lock} repo --project P --locked`,
      `run ${lock} repo --project P --locked ruff --version`,
      `run ${lock} repo --project P --locked mypy --version`,
      `run ${lock} backend --project P --locked ruff check --no-cache --config P/pyproject.toml --statistics .`,
      `run ${lock} backend --project P --locked ruff format --no-cache --config P/pyproject.toml --check .`,
      `run ${lock} backend --project P --locked mypy --config-file P/pyproject.toml --cache-dir P/.mypy_cache .`,
    ];
    expect(calls).toEqual([...runs("lock-antiga"), ...runs("lock-nova")]);
  });
});

describe("measure-gate-bump.sh", () => {
  // Os hooks e o ruff/mypy leem o worktree, e o gitleaks o HEAD: com mudança
  // não commitada, a medição juntaria duas árvores.
  it("recusa medir com mudança não commitada em arquivo versionado", () => {
    write("versionado.txt", "editado\n");
    const { status, stderr, calls } = measure(["uv", base]);
    expect(status).toBe(2);
    expect(stderr).toContain("mudança não commitada");
    expect(calls).toEqual([]);
  });
});
