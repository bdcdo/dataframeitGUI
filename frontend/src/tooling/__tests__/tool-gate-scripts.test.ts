import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Contrato dos scripts de gate que invocam binário pinado de node_modules
// (scripts/react-doctor-gate.sh e scripts/fallow-audit-gate.sh, #652): os dois
// falham fechado com o instalado != pinado pelo mesmo
// scripts/gates/lib/assert-pinned-version.sh, e o do fallow falha com qualquer
// WARN do `fallow config` (regra desconhecida e .fallowrc.jsonc sombreado por
// outro arquivo são os dois casos medidos). Cada caso monta um frontend/
// temporário com cópia dos scripts e um binário falso que registra as chamadas.

const realFrontend = fileURLToPath(new URL("../../../", import.meta.url));
const LIB = "scripts/gates/lib/assert-pinned-version.sh";

const REACT_DOCTOR = { pkg: "react-doctor", script: "scripts/react-doctor-gate.sh", calls: [". --scope lines --base HEAD --blocking warning"] };
const FALLOW = { pkg: "fallow", script: "scripts/fallow-audit-gate.sh", calls: ["config", "audit --base origin/main"] };
type Gate = typeof FALLOW;

// O `config` do fallow escreve a config resolvida no stdout e os avisos no
// stderr, que é onde sai o `unknown rule`.
const FAKE_BIN = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
if [ "$1" = config ]; then
  echo '{}'
  printf '%s' "\${FAKE_CONFIG_STDERR:-}" >&2
  exit "\${FAKE_CONFIG_EXIT:-0}"
fi
`;

let root: string;
let frontend: string;
let log: string;

function write(file: string, content: string, mode?: number) {
  const target = path.join(frontend, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  if (mode) fs.chmodSync(target, mode);
}

function copyScripts(gate: Gate, pinned: string) {
  for (const file of [gate.script, LIB]) write(file, fs.readFileSync(path.join(realFrontend, file), "utf8"));
  write("package.json", JSON.stringify({ devDependencies: { [gate.pkg]: pinned } }));
}

function setup(gate: Gate, { pinned, installed, bin = true }: { pinned: string; installed: string | null; bin?: boolean }) {
  copyScripts(gate, pinned);
  if (installed) write(`node_modules/${gate.pkg}/package.json`, JSON.stringify({ version: installed }));
  if (bin) write(`node_modules/.bin/${gate.pkg}`, FAKE_BIN, 0o755);
}

function run(script: string, env: Record<string, string> = {}) {
  const result = spawnSync("/bin/bash", [path.join(frontend, script)], {
    cwd: root,
    env: { ...process.env, FAKE_LOG: log, ...env },
    encoding: "utf8",
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
  return { status: result.status, stderr: result.stderr, calls };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tool-gate-scripts-"));
  frontend = path.join(root, "frontend");
  log = path.join(root, "calls.log");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe.each([REACT_DOCTOR, FALLOW])("$script: guarda de versão", (gate) => {
  it("binário ausente falha fechado", () => {
    setup(gate, { pinned: "1.0.0", installed: "1.0.0", bin: false });
    const result = run(gate.script);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${gate.pkg} ausente em frontend/node_modules`);
  });

  it("instalado != pinado falha fechado sem rodar a ferramenta", () => {
    setup(gate, { pinned: "1.0.0", installed: "1.0.1" });
    const result = run(gate.script);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${gate.pkg} instalado (1.0.1) != pinado (1.0.0)`);
    expect(result.calls).toEqual([]);
  });

  it("pacote ausente de node_modules falha fechado", () => {
    setup(gate, { pinned: "1.0.0", installed: null });
    const result = run(gate.script);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${gate.pkg} instalado (ausente) != pinado (1.0.0)`);
    expect(result.calls).toEqual([]);
  });

  it("pino com faixa (^) falha fechado pedindo versão exata", () => {
    setup(gate, { pinned: "^1.0.0", installed: "1.0.0" });
    const result = run(gate.script);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${gate.pkg} pinado como "^1.0.0"`);
    expect(result.calls).toEqual([]);
  });

  it("instalado == pinado roda a ferramenta", () => {
    setup(gate, { pinned: "1.0.0", installed: "1.0.0" });
    const result = run(gate.script);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.calls).toEqual(gate.calls);
  });
});

describe("scripts/fallow-audit-FALLOW.sh: aviso sobre a config", () => {
  it("`unknown rule` no stderr do `fallow config` barra antes do audit", () => {
    setup(FALLOW, { pinned: "1.0.0", installed: "1.0.0" });
    const warning = "WARN unknown rule 'regra-que-sumiu' in rules of .fallowrc.jsonc; the rule will be ignored.\n";
    const result = run(FALLOW.script, { FAKE_CONFIG_STDERR: warning });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown rule 'regra-que-sumiu'");
    expect(result.calls).toEqual(["config"]);
  });

  it("`fallow config` com erro barra antes do audit", () => {
    setup(FALLOW, { pinned: "1.0.0", installed: "1.0.0" });
    const result = run(FALLOW.script, { FAKE_CONFIG_STDERR: "config invalida\n", FAKE_CONFIG_EXIT: "2" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("config invalida");
    expect(result.calls).toEqual(["config"]);
  });

  // O binário falso acima imita o aviso; aqui o fallow instalado de verdade, com
  // uma config sabotada, prova o texto do aviso e que ele sai no stderr. O
  // fallow e o node que o embrulha levam de 1 a 2 s de parede só, e o timeout
  // padrão de 5 s não cobre a suíte disputando a CPU.
  const REAL_FALLOW_TIMEOUT_MS = 30_000;
  function setupRealFallow(configs: Record<string, object>) {
    const version = (JSON.parse(fs.readFileSync(path.join(realFrontend, "node_modules/fallow/package.json"), "utf8")) as { version: string }).version;
    copyScripts(FALLOW, version);
    for (const [file, content] of Object.entries(configs)) write(file, JSON.stringify(content));
    fs.mkdirSync(path.join(frontend, "node_modules/.bin"), { recursive: true });
    fs.symlinkSync(path.join(realFrontend, "node_modules/fallow"), path.join(frontend, "node_modules/fallow"));
    fs.symlinkSync(path.join(realFrontend, "node_modules/.bin/fallow"), path.join(frontend, "node_modules/.bin/fallow"));
  }

  it("com o fallow instalado, uma regra inexistente derruba o gate", () => {
    setupRealFallow({ ".fallowrc.jsonc": { rules: { "misplaced-directive": "error", "regra-inexistente": "error" } } });
    const result = run(FALLOW.script);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown rule 'regra-inexistente'");
    expect(result.stderr).not.toContain("misplaced-directive");
  }, REAL_FALLOW_TIMEOUT_MS);

  it("com o fallow instalado, um .fallowrc.json que sombreia o .fallowrc.jsonc derruba o gate", () => {
    setupRealFallow({
      ".fallowrc.jsonc": { rules: { "misplaced-directive": "error" } },
      ".fallowrc.json": { rules: { "misplaced-directive": "warn" } },
    });
    const result = run(FALLOW.script);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ignoring '.fallowrc.jsonc'");
  }, REAL_FALLOW_TIMEOUT_MS);
});
