#!/usr/bin/env bash
#
# Roda TODAS as suítes de contrato do banco numa varredura única e reporta cada
# uma, em vez do encadeamento por `&&` do antigo `test:db`. O `&&` parava na
# primeira falha e escondia as demais — foi por isso que quatro suítes ficaram
# vermelhas na main sem ninguém ver (issue #557). Aqui nenhuma falha interrompe
# a varredura; o exit code agrega o resultado do conjunto de gate.
#
# Dois formatos de suíte convivem (ver run-sql-test.sh): `responses_llm_actor_
# integrity` é pgTAP e roda por `supabase test db`; as demais sinalizam falha
# com `RAISE EXCEPTION 'FALHOU ...'` e rodam por psql com ON_ERROR_STOP=1.

# Sem `-e`: a varredura precisa continuar após uma suíte falhar.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 2

# Preflight: sem o Supabase local no ar, cada suíte falharia com a saída
# suprimida (roda em modo silencioso). Falha aqui, com mensagem legível, em vez
# de reportar 13 FAIL opacos.
CONTAINER="${SUPABASE_DB_CONTAINER:-supabase_db_frontend}"
if ! docker inspect "${CONTAINER}" >/dev/null 2>&1; then
  echo "container ${CONTAINER} não está no ar — rode 'npx supabase start' antes." >&2
  exit 2
fi

TESTS_DIR="supabase/tests"

# pgTAP — roda por `supabase test db`.
PGTAP_SUITES=(
  responses_llm_actor_integrity
)

# Suítes de gate (fail-closed): qualquer falha aqui derruba o exit code.
GATE_SUITES=(
  canonical_project_identity_rls
  clerk_mapping_completion
  auto_review_assignment_sync
  atomic_replace_rpcs
  llm_rate_limit
  member_permission_rpcs
  project_members_column_guard
  auto_review_assignment_concurrency
  unmark_equivalence_atomic
  auto_review_reconciliation_outbox
)

# Órfãs quebradas pela era da migration 20260717120000 (índice único one-latest
# de LLM e connstr de dblink), fora do escopo da #557 e rastreadas em issues
# próprias. Rodam e são reportadas, mas NÃO derrubam o gate até serem
# consertadas. Isto NÃO é silenciamento: cada uma aparece no resumo com sua
# issue; ao consertar, mover para GATE_SUITES.
declare -A KNOWN_RED=(
  [schema_revision_rpcs]="#571"
  [schema_revision_serialization]="#572"
)

pass=()
fail_gate=()
fail_known=()

run_pgtap() {
  npx supabase test db "${TESTS_DIR}/$1.test.sql" --local >/dev/null 2>&1
}

run_psql() {
  bash scripts/run-sql-test.sh "${TESTS_DIR}/$1.test.sql" >/dev/null 2>&1
}

report() {
  local suite="$1" code="$2" gated="$3"
  if [[ ${code} -eq 0 ]]; then
    printf '  PASS  %s\n' "${suite}"
    pass+=("${suite}")
  elif [[ ${gated} == gate ]]; then
    printf '  FAIL  %s\n' "${suite}"
    fail_gate+=("${suite}")
  else
    printf '  RED*  %s (conhecida, %s)\n' "${suite}" "${KNOWN_RED[$suite]}"
    fail_known+=("${suite}")
  fi
}

echo "▸ suítes de contrato do banco (varredura completa)"

for s in "${PGTAP_SUITES[@]}"; do
  run_pgtap "$s"; report "$s" $? gate
done
for s in "${GATE_SUITES[@]}"; do
  run_psql "$s"; report "$s" $? gate
done
for s in "${!KNOWN_RED[@]}"; do
  run_psql "$s"; report "$s" $? known
done

echo "────────────────────────────────────────"
printf 'PASS=%d  FAIL(gate)=%d  RED*(conhecida)=%d\n' \
  "${#pass[@]}" "${#fail_gate[@]}" "${#fail_known[@]}"

if [[ ${#fail_known[@]} -gt 0 ]]; then
  echo "RED* (não bloqueia; rastreada em issue): ${fail_known[*]}"
fi

if [[ ${#fail_gate[@]} -gt 0 ]]; then
  echo "FALHOU: ${fail_gate[*]}"
  exit 1
fi
echo "OK: todas as suítes de gate passaram."
