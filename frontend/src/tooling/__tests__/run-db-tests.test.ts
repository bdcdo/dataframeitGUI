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

// Sai com 3 e 30 linhas numeradas se o arquivo de suíte, achado pelo teste
// `$1 "$file"`, está em FAKE_FAIL_FILES.
const failIfListed = (test: string) => `IFS=: read -ra failing <<<"$FAKE_FAIL_FILES"
for file in "\${failing[@]}"; do
  if ${test} "$file"; then
    for i in $(seq 30); do echo "linha $i de $(basename "$file")"; done
    exit 3
  fi
done`;

const fakes: Record<string, string> = {
  docker: `#!/usr/bin/env bash
case "$1" in
  inspect)
    case "$*" in
      *State.Running*) echo true ;;
      *Networks*) echo 172.17.0.2 ;;
    esac ;;
  exec)
    input="$(mktemp -p "$FAKE_BIN")"; cat >"$input"
    # Cada chamada registra no log o usuário (-U), se o preâmbulo do dblink
    # veio por -c, e a primeira linha da suíte que entrou por stdin.
    user="$(printf '%s\n' "$@" | grep -A1 -x -- -U | tail -1)"
    preamble="$(printf '%s\n' "$@" | grep -c "pg_temp.self_dblink_connstr")"
    echo "$user $preamble $(head -1 "$input")" >>"$FAKE_BIN/psql.log"
    same_sql() { cmp -s "$input" "$1"; }
    ${failIfListed("same_sql")} ;;
  *) echo "docker inesperado: $*" >&2; exit 64 ;;
esac
`,
  npx: `#!/usr/bin/env bash
case "$*" in
  "supabase status -o env") printf 'API_URL="http://127.0.0.1:54321"\\nSERVICE_ROLE_KEY="chave"\\n' ;;
  "supabase test db "*)
    suite="$(realpath "$4")"
    same_suite() { [[ $suite == "$1" ]]; }
    ${failIfListed("same_suite")} ;;
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

function run(failing: string[], env: Record<string, string> = {}, suites: string[] = []) {
  // O próprio CI define GITHUB_ACTIONS; aqui só o caso que o pede o tem.
  return spawnSync("/bin/bash", [runner, ...suites], {
    env: { ...process.env, GITHUB_ACTIONS: "", PATH: `${bin}:${process.env.PATH}`, FAKE_BIN: bin, FAKE_FAIL_FILES: failing.map(suite).join(":"), ...env },
    encoding: "utf8",
  });
}

const psqlLog = () => fs.readFileSync(path.join(bin, "psql.log"), "utf8");

describe("run-db-tests.sh", () => {
  it("sem falha, aprova a varredura inteira", () => {
    const { status, stdout } = run([]);
    expect(stdout).toContain("OK: todas as suítes de gate passaram.");
    expect(stdout).toContain("RED*(conhecida)=0");
    expect(status).toBe(0);
  });

  // value_equivalences saiu de KNOWN_RED (#913): conecta como supabase_admin,
  // a única que não usa postgres, e a falha dela reprova.
  it("value_equivalences é gate e conecta como supabase_admin", () => {
    const { status, stdout } = run(["value_equivalences"]);
    expect(stdout).toContain("  FAIL  value_equivalences");
    expect(status).toBe(1);
    const calls = psqlLog().trim().split("\n");
    // A única conexão de supabase_admin é a da suíte com a diretiva.
    const directive = fs.readFileSync(suite("value_equivalences"), "utf8").split("\n")[0];
    expect(directive).toBe("-- @test-role: supabase_admin");
    expect(calls.filter((line) => line.startsWith("supabase_admin "))).toEqual([
      `supabase_admin 1 ${directive}`,
    ]);
    expect(calls.filter((line) => !/^(postgres|supabase_admin) /.test(line))).toEqual([]);
  });

  // O connstr do dblink das suítes concorrentes vem do preâmbulo, por -c, na
  // mesma sessão e antes da suíte (supabase/tests/lib/self_dblink.sql); a suíte
  // entra inteira por stdin.
  it("toda suíte psql recebe o preâmbulo do dblink por -c e a suíte por stdin", () => {
    run([]);
    const calls = psqlLog().trim().split("\n").map((line) => line.split(" "));
    const dir = path.join(frontend, "supabase/tests");
    const suites = fs.readdirSync(dir).filter((name) => name.endsWith(".test.sql"));
    const firstLines = new Set(
      suites.map((name) => fs.readFileSync(path.join(dir, name), "utf8").split("\n")[0]),
    );
    // Todas menos as duas pgTAP, que rodam por `supabase test db`.
    expect(calls).toHaveLength(suites.length - 2);
    for (const [, preamble, ...firstLine] of calls) {
      expect(preamble).toBe("1");
      expect(firstLines.has(firstLine.join(" "))).toBe(true);
    }
  });

  it("com nomes, roda só as suítes pedidas; nome desconhecido é erro", () => {
    const only = run([], {}, ["rls_audit", "responses_llm_actor_integrity"]);
    expect(only.status).toBe(0);
    expect(only.stdout).toContain("  PASS  rls_audit");
    expect(only.stdout).toContain("  PASS  responses_llm_actor_integrity");
    expect(only.stdout).toMatch(/PASS=2 {2}FAIL\(gate\)=0/);
    expect(only.stdout).not.toContain("backend_integration");
    expect(only.stdout).toContain("OK: as suítes pedidas passaram (execução parcial).");

    const unknown = run([], {}, ["nao_existe"]);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("suíte desconhecida: nao_existe");
    expect(run([], {}, [""]).status).toBe(2);
  });

  it("reprova a suíte de gate que falha, com a cauda da saída", () => {
    // schema_revision_serialization saiu de KNOWN_RED (#572): a falha dela reprova.
    const { status, stdout } = run(["rls_audit", "schema_revision_serialization"]);
    expect(status).toBe(1);
    expect(stdout).toContain("  FAIL  rls_audit");
    expect(stdout).toContain("  FAIL  schema_revision_serialization");
    expect(stdout).toContain("linha 30 de rls_audit.test.sql");
    expect(stdout).not.toContain("linha 1 de rls_audit.test.sql\n");
    expect(stdout).not.toContain("::group::");
  });

  // O workflow roda tudo num passo só. O passo por suíte de antes mostrava a
  // saída inteira de cada uma e, num travamento, qual suíte estava rodando.
  it("no GitHub Actions abre um grupo por suíte, antes de rodá-la, com a saída inteira", () => {
    const { status, stdout } = run(["rls_audit", "responses_llm_actor_integrity"], { GITHUB_ACTIONS: "true" });
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
    expect(stdout).toContain("::group::value_equivalences\n");
    expect(stdout).not.toContain("::error title=Suíte do banco value_equivalences");
    // A saída inteira já está no grupo: a cauda não se repete.
    expect(stdout).not.toContain("saída (cauda)");
  });
});
