import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isolatedGitEnvironment, runGit } from "@/test-utils/isolated-git";

// O hook de pre-push `semgrep` (scripts/semgrep-gate.sh): achado reprova
// sempre; erro de infra libera o push local e reprova no CI, que roda o mesmo
// script com GATE_FAIL_OPEN=0 (#649).

const frontend = fileURLToPath(new URL("../../../", import.meta.url));
const script = path.join(frontend, "scripts/semgrep-gate.sh");
const preCommitConfig = fs.readFileSync(path.join(frontend, "../.pre-commit-config.yaml"), "utf8");

it("o hook chama o script, sem lógica própria no entry", () => {
  const hook = preCommitConfig.slice(preCommitConfig.indexOf("- id: semgrep\n"));
  const block = hook.slice(0, hook.indexOf("\n      - id:", 1));
  expect(block).toContain("entry: bash frontend/scripts/semgrep-gate.sh\n");
});

// Repositório de brinquedo com o script, uma branch à frente da main e um uvx
// falso que sai com os códigos de `plan`, um por chamada, e registra cada uma.
describe("semgrep-gate.sh", () => {
  let repo: string;

  function commit(message: string) {
    runGit(["add", "-A"], repo);
    runGit(
      ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", message],
      repo,
    );
  }

  function gate(plan: number[], env: Record<string, string> = {}) {
    fs.writeFileSync(path.join(repo, "plan"), plan.map((code) => `${code}\n`).join(""));
    // O ci.yml dá GATE_FAIL_OPEN=0 a toda célula, inclusive à que roda este
    // teste: sem tirá-lo, os casos do default (push local) herdariam o do CI.
    const base = isolatedGitEnvironment();
    delete base.GATE_FAIL_OPEN;
    const result = spawnSync("bash", [path.join(repo, "frontend/scripts/semgrep-gate.sh")], {
      encoding: "utf8",
      env: { ...base, SEMGREP_UVX: path.join(repo, "fake-uvx"), SEMGREP_RETRY_SLEEP: "0", ...env },
    });
    const callsFile = path.join(repo, "calls");
    const calls = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").trim().split("\n") : [];
    return { ...result, calls };
  }

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "semgrep-gate-"));
    runGit(["init", "-q", "-b", "main"], repo);
    const target = path.join(repo, "frontend/scripts/semgrep-gate.sh");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(script, target);
    fs.writeFileSync(
      path.join(repo, "fake-uvx"),
      [
        "#!/usr/bin/env bash",
        'dir="$(dirname "$0")"',
        'echo "$*" >>"$dir/calls"',
        'code="$(head -n 1 "$dir/plan")"',
        'sed -i 1d "$dir/plan"',
        'echo "saída do semgrep (exit $code)"',
        'exit "$code"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(repo, ".gitignore"), "plan\ncalls\n");
    commit("base");
    runGit(["checkout", "-q", "-b", "feature"], repo);
    fs.mkdirSync(path.join(repo, "backend"));
    fs.writeFileSync(path.join(repo, "backend/a.py"), "x = 1\n");
    commit("mexe no backend");
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("execução limpa passa, com o engine pinado e a base na main", () => {
    const { status, calls } = gate([0]);
    expect(status).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^--from semgrep==\d+\.\d+\.\d+ semgrep scan /);
    expect(calls[0]).toContain(`--baseline-commit ${runGit(["rev-parse", "main"], repo).trim()} `);
  });

  it.each<Record<string, string>>([{}, { GATE_FAIL_OPEN: "0" }])("achado reprova, sem nova tentativa (%o)", (env) => {
    const { status, stderr, calls } = gate([1], env);
    expect(status).toBe(1);
    expect(stderr).toContain("saída do semgrep (exit 1)");
    expect(calls).toHaveLength(1);
  });

  it("erro de infra libera o push local, numa tentativa só", () => {
    const { status, stderr, calls } = gate([2]);
    expect(status).toBe(0);
    expect(stderr).toContain("push liberado");
    expect(calls).toHaveLength(1);
  });

  it("erro de infra reprova com GATE_FAIL_OPEN=0, depois de duas novas tentativas", () => {
    const { status, stderr, calls } = gate([2, 2, 2], { GATE_FAIL_OPEN: "0" });
    expect(status).toBe(1);
    expect(stderr).toContain("GATE_FAIL_OPEN=0 reprova");
    expect(stderr).toContain("saída do semgrep (exit 2)");
    expect(calls).toHaveLength(3);
  });

  it("erro de infra que passa na nova tentativa não reprova", () => {
    const { status, calls } = gate([2, 0], { GATE_FAIL_OPEN: "0" });
    expect(status).toBe(0);
    expect(calls).toHaveLength(2);
  });

  it("achado numa nova tentativa reprova", () => {
    const { status, calls } = gate([2, 1], { GATE_FAIL_OPEN: "0" });
    expect(status).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it("uvx ausente libera o push local e reprova com GATE_FAIL_OPEN=0", () => {
    const missing = { SEMGREP_UVX: path.join(repo, "uvx-que-nao-existe") };
    const local = gate([], missing);
    expect(local.status).toBe(0);
    expect(local.stderr).toContain("uvx ausente");
    const ci = gate([], { ...missing, GATE_FAIL_OPEN: "0" });
    expect(ci.status).toBe(1);
    expect(ci.stderr).toContain("uvx ausente");
  });

  // O push na própria main: a base é o HEAD, e o semgrep nem é chamado.
  it("sem mudança em frontend/ ou backend/ desde a base, passa sem chamar o semgrep", () => {
    runGit(["checkout", "-q", "main"], repo);
    const { status, stdout, calls } = gate([2], { GATE_FAIL_OPEN: "0" });
    expect(status).toBe(0);
    expect(stdout).toContain("nada mudou");
    expect(calls).toHaveLength(0);
  });
});
