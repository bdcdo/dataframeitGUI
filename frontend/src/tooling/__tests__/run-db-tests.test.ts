import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Relatório do scripts/run-db-tests.sh, o runner do `test:db` que o hook
// db-tests e o database-tests.yml chamam. O Supabase é falso: o `docker` aceita
// toda suíte por psql e o `npx supabase test db` toda pgTAP, menos os arquivos
// listados em FAKE_FAIL_FILES, que imprimem 30 linhas numeradas e saem com 3.
// O `uv` do contrato dos writes de llm_runs sai com 0. As suítes são as do
// disco, então a guarda de drift do runner também roda.

const frontend = fileURLToPath(new URL("../../../", import.meta.url));
const runner = path.join(frontend, "scripts/run-db-tests.sh");
const suite = (name: string) => path.join(frontend, "supabase/tests", `${name}.test.sql`);

const fakeOutput = 'for i in $(seq 30); do echo "linha $i de $1"; done';
const fakes: Record<string, string> = {
  docker: `#!/usr/bin/env bash
case "$1" in
  inspect)
    case "$*" in
      *State.Running*) echo true ;;
      *Networks*) echo 172.17.0.2 ;;
    esac
    exit 0 ;;
  exec)
    input="$(mktemp)"; cat >"$input"
    IFS=: read -ra failing <<<"$FAKE_FAIL_FILES"
    for file in "\${failing[@]}"; do
      if cmp -s "$input" "$file"; then fail() { ${fakeOutput}; }; fail "$(basename "$file")"; exit 3; fi
    done
    exit 0 ;;
esac
echo "docker inesperado: $*" >&2; exit 64
`,
  npx: `#!/usr/bin/env bash
case "$*" in
  "supabase status -o env") printf 'API_URL="http://127.0.0.1:54321"\\nSERVICE_ROLE_KEY="chave"\\n' ;;
  "supabase test db "*)
    IFS=: read -ra failing <<<"$FAKE_FAIL_FILES"
    for file in "\${failing[@]}"; do
      if [[ "$(realpath "$4")" == "$file" ]]; then fail() { ${fakeOutput}; }; fail "$(basename "$file")"; exit 3; fi
    done ;;
  *) echo "npx inesperado: $*" >&2; exit 64 ;;
esac
`,
  uv: "#!/usr/bin/env bash\nexit 0\n",
};

let bin: string;

beforeEach(() => {
  bin = fs.mkdtempSync(path.join(os.tmpdir(), "run-db-tests-"));
  for (const [name, content] of Object.entries(fakes)) {
    fs.writeFileSync(path.join(bin, name), content, { mode: 0o755 });
  }
});

afterEach(() => {
  fs.rmSync(bin, { recursive: true, force: true });
});

function run(failing: string[], env: Record<string, string> = {}) {
  // O próprio CI define GITHUB_ACTIONS; aqui só o caso que o pede o tem.
  return spawnSync("/bin/bash", [runner], {
    env: { ...process.env, GITHUB_ACTIONS: "", PATH: `${bin}:${process.env.PATH}`, FAKE_FAIL_FILES: failing.map(suite).join(":"), ...env },
    encoding: "utf8",
  });
}

// A órfã conhecida (#572) falha em toda execução de hoje.
const knownRed = "schema_revision_serialization";

describe("run-db-tests.sh", () => {
  it("reporta a órfã conhecida como RED* sem reprovar", () => {
    const { status, stdout } = run([knownRed]);
    expect(stdout).toContain(`RED*  ${knownRed} (conhecida, #572)`);
    expect(stdout).toContain("OK: todas as suítes de gate passaram.");
    expect(status).toBe(0);
  });

  it("reprova a suíte de gate que falha, com a cauda da saída", () => {
    const { status, stdout } = run([knownRed, "rls_audit"]);
    expect(status).toBe(1);
    expect(stdout).toContain("  FAIL  rls_audit");
    expect(stdout).toContain("linha 30 de rls_audit.test.sql");
    expect(stdout).not.toContain("linha 1 de rls_audit.test.sql\n");
    expect(stdout).not.toContain("::group::");
  });

  // O workflow roda tudo num passo só. O passo por suíte de antes mostrava a
  // saída inteira de cada uma e, num travamento, qual suíte estava rodando.
  it("no GitHub Actions abre um grupo por suíte, antes de rodá-la, com a saída inteira", () => {
    const { status, stdout } = run([knownRed, "rls_audit", "responses_llm_actor_integrity"], { GITHUB_ACTIONS: "true" });
    expect(status).toBe(1);
    for (const failed of ["rls_audit", "responses_llm_actor_integrity"]) {
      const start = stdout.indexOf(`::group::${failed}\n`);
      expect(start).toBeGreaterThanOrEqual(0);
      const group = stdout.slice(start, stdout.indexOf("::endgroup::", start));
      expect(group).toContain(`\nlinha 1 de ${failed}.test.sql\n`);
      expect(group).toMatch(new RegExp(`linha 30 de ${failed}\\.test\\.sql\\n$`));
      expect(stdout.slice(start)).toContain(`::endgroup::\n  FAIL  ${failed}`);
      expect(stdout).toContain(`::error title=Suíte do banco ${failed}::`);
    }
    expect(stdout).toContain("::group::backend_integration\n");
    expect(stdout).toContain(`::group::${knownRed}\n`);
    expect(stdout).not.toContain(`::error title=Suíte do banco ${knownRed}`);
  });
});
