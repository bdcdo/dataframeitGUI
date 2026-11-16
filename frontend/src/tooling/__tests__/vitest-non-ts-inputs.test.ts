import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isolatedGitEnvironment, runGit } from "@/test-utils/isolated-git";

// O hook de pre-push `vitest-non-ts-inputs` (scripts/vitest-non-ts-inputs.sh):
// as suítes que leem migrations, suítes SQL e arquivos do backend saem de uma
// varredura, e o disparo enxerga arquivo removido, que o pre-commit não passa
// ao `files:`.

const frontend = fileURLToPath(new URL("../../../", import.meta.url));
const script = path.join(frontend, "scripts/vitest-non-ts-inputs.sh");
const preCommitConfig = fs.readFileSync(path.join(frontend, "../.pre-commit-config.yaml"), "utf8");

describe("suítes do hook", () => {
  it("saem da varredura: toda suíte que lê esses caminhos, inclusive as que a lista à mão esquecia", () => {
    const { stdout, status } = spawnSync("bash", [script, "--list"], { encoding: "utf8" });
    expect(status).toBe(0);
    const suites = stdout.trim().split("\n");
    for (const expected of [
      "src/lib/__tests__/model-registry.test.ts",
      "src/lib/__tests__/pydantic-field-names.test.ts",
      "src/lib/__tests__/schema-roundtrip.property.test.ts",
      "src/lib/__tests__/error-resolution-cycle.test.ts",
      // Fora da lista à mão: liam migration ou JSON do backend sem rodar no push.
      "src/lib/__tests__/error-resolution.test.ts",
      "src/lib/__tests__/upload-chunking.test.ts",
      "src/lib/__tests__/schema-utils-versioning.test.ts",
    ]) {
      expect(suites).toContain(expected);
    }
    // A que varre o repositório inteiro entra pelo marcador.
    expect(suites).toContain("src/lib/__tests__/supabase-admin-boundary.test.ts");
    // Teste que não lê esses caminhos fica de fora.
    expect(suites).not.toContain("src/lib/__tests__/server-error.test.ts");
  });

  it("o hook chama o script sempre, sem `files:` e sem lista de suítes", () => {
    const hook = preCommitConfig.slice(preCommitConfig.indexOf("- id: vitest-non-ts-inputs"));
    const block = hook.slice(0, hook.indexOf("\n      - id:", 1));
    expect(block).toContain("entry: bash frontend/scripts/vitest-non-ts-inputs.sh");
    expect(block).toContain("always_run: true");
    expect(block).not.toMatch(/^\s+files:/m);
  });
});

// Repositório de brinquedo com o script, uma suíte que lê migration e um
// vitest falso que registra o que recebeu.
describe("disparo pelo diff do push", () => {
  let repo: string;

  function write(file: string, content: string) {
    const full = path.join(repo, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, { mode: file.endsWith(".sh") ? 0o755 : 0o644 });
  }

  function commit(message: string): string {
    runGit(["add", "-A"], repo);
    runGit(
      ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", message],
      repo,
    );
    return runGit(["rev-parse", "HEAD"], repo).trim();
  }

  function push(from: string, to: string) {
    return spawnSync("bash", [path.join(repo, "frontend/scripts/vitest-non-ts-inputs.sh")], {
      encoding: "utf8",
      env: {
        ...isolatedGitEnvironment(),
        PRE_COMMIT_FROM_REF: from,
        PRE_COMMIT_TO_REF: to,
        VITEST_BIN: path.join(repo, "fake-vitest"),
      },
    });
  }

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "non-ts-inputs-"));
    runGit(["init", "-q"], repo);
    write("frontend/scripts/vitest-non-ts-inputs.sh", fs.readFileSync(script, "utf8"));
    write(
      "frontend/src/lib/__tests__/le-migration.test.ts",
      'readdirSync(join(__dirname, "supabase", "migrations"));\n',
    );
    write("frontend/supabase/migrations/1_inicial.sql", "select 1;\n");
    write("README.md", "x\n");
    write("fake-vitest", '#!/usr/bin/env bash\necho "vitest $*"\n');
    fs.chmodSync(path.join(repo, "fake-vitest"), 0o755);
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("migration removida dispara as suítes", () => {
    const base = commit("base");
    fs.rmSync(path.join(repo, "frontend/supabase/migrations/1_inicial.sql"));
    const removed = commit("remove migration");
    const { status, stdout } = push(base, removed);
    expect(status).toBe(0);
    expect(stdout).toContain("vitest run src/lib/__tests__/le-migration.test.ts");
  });

  // Com `git diff | grep -q` sob pipefail, o grep sai no primeiro acerto, o
  // git morre de SIGPIPE quando a lista passa do buffer do pipe (64 KB) e o
  // acerto virava "pulado".
  it("push grande, com o acerto no começo da lista, ainda dispara", () => {
    const base = commit("base");
    write("backend/services/a.py", "x = 1\n");
    const many = path.join(repo, "zz");
    fs.mkdirSync(many);
    // O que passa do buffer é o tamanho da lista de nomes, e não o número de
    // arquivos: 300 nomes de ~250 caracteres dão ~75 KB.
    for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(many, `${"a".repeat(240)}${i}`), "");
    const big = commit("grande");
    const { status, stdout } = push(base, big);
    expect(status).toBe(0);
    expect(stdout).toContain("vitest run src/lib/__tests__/le-migration.test.ts");
  });

  it("falha do git no diff derruba o hook, em vez de pular", () => {
    const base = commit("base");
    const { status, stdout } = push(base, "ref-que-nao-existe");
    expect(status).not.toBe(0);
    expect(stdout).not.toContain("pulado");
  });

  it("push sem esses caminhos pula", () => {
    const base = commit("base");
    write("README.md", "y\n");
    const docs = commit("docs");
    const { status, stdout } = push(base, docs);
    expect(status).toBe(0);
    expect(stdout).toContain("pulado");
    expect(stdout).not.toContain("vitest run");
  });
});
