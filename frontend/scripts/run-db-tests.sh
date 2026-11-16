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
#
# Quatro guardas fecham os modos de drift que originaram ou disfarçariam a #557
# (a quarta veio da #650):
#   1. Drift disco↔runner: a causa raiz da #557 foi uma suíte .test.sql fora de
#      toda cadeia. Aqui, qualquer .test.sql no disco não classificado em um dos
#      três conjuntos — ou qualquer suíte listada sem arquivo no disco — derruba
#      o gate ANTES de rodar. O estado "suíte fora do gate" fica irrepresentável.
#   2. KNOWN_RED que fica verde: quando uma órfã rastreada passa a passar, o gate
#      falha pedindo a promoção para GATE_SUITES — a exceção não apodrece
#      silenciosamente até alguém reparar (drift no sentido bom, mas ainda drift).
#   3. Diagnóstico em falha: a saída de cada suíte vai para um log; em FAIL de
#      gate a cauda é impressa, sem exigir re-run da suíte.
#   4. KNOWN_RED fóssil: toda entrada aponta para uma issue (#N) ABERTA. Uma
#      suíte silenciada por issue já fechada derruba o gate antes de rodar.
#      Sem `gh`, sem rede ou sem login, a consulta é pulada com aviso (fail-open);
#      a entrada sem `#N` falha sempre, porque não depende de rede.
#
# Uso: `npm run test:db` roda tudo; `npm run test:db -- <suíte> [<suíte>...]`
# roda só as nomeadas (o nome do arquivo sem `.test.sql`, ou
# `backend_integration`). As listas abaixo são a fonte única das suítes.

# Sem `-e`: a varredura precisa continuar após uma suíte falhar.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 2

# Preflight: o container precisa estar RODANDO, não só existir. Um container
# parado passaria por `docker inspect` puro e cada suíte falharia com a saída
# suprimida — 13 FAIL opacos em vez de uma mensagem legível.
CONTAINER="${SUPABASE_DB_CONTAINER:-supabase_db_frontend}"
if [[ "$(docker inspect -f '{{.State.Running}}' "${CONTAINER}" 2>/dev/null)" != true ]]; then
  echo "container ${CONTAINER} não está rodando — rode 'npx supabase start' antes." >&2
  exit 2
fi

TESTS_DIR="supabase/tests"

# pgTAP — roda por `supabase test db`.
PGTAP_SUITES=(
  responses_llm_actor_integrity
  response_references_document_scoped
)

# Suítes de gate (fail-closed): qualquer falha aqui derruba o exit code.
GATE_SUITES=(
  canonical_project_identity_rls
  clerk_mapping_completion
  auto_review_assignment_sync
  atomic_replace_rpcs
  explicit_assignment_rounds
  projects_pydantic_fields_shape
  round_write_maintenance
  llm_rate_limit
  llm_runs_round
  reviews_round_id
  reviews_field_hash
  judgments_follow_question
  both_correct_common_value
  llm_error_decision_follows_field_hash
  replace_documents_keeps_judged_text
  verdict_acknowledgments_pinned
  note_resolution_follows_note
  llm_error_decisions
  llm_error_decisions_concurrency
  member_permission_rpcs
  project_members_column_guard
  responses_one_latest_human
  responses_one_latest_llm_cross_round
  auto_review_assignment_concurrency
  responses_latest_human_concurrency
  response_round_serialization
  unmark_equivalence_atomic
  auto_review_reconciliation_outbox
  arbitration_reopen
  rls_audit
  remove_project_member_self_identity
  visible_if_no_codigo_pydantic
  self_comparison_exception
  schema_revision_rpcs
  error_resolution_cycle
  schema_revision_serialization
  value_equivalences
)

# Suíte vermelha rastreada em issue própria. Roda e é reportada, mas NÃO
# derruba o gate até ser consertada. Isto NÃO é silenciamento: aparece no resumo
# com sua issue; ao consertar, mover para GATE_SUITES (a guarda 2 força esse
# passo). Vazia hoje: value_equivalences (#913) foi a última, e passou a rodar
# como `supabase_admin` (diretiva no topo da suíte, lida pelo run-sql-test.sh).
declare -A KNOWN_RED=()

# ── Guarda 1: drift entre o runner e o disco (fecha a causa raiz da #557). ────
# O conjunto classificado é a união dos três; a fonte da verdade de "quem é
# suíte" é o glob *.test.sql. Divergência nos dois sentidos derruba o gate antes
# de rodar qualquer coisa.
declare -A CLASSIFIED=()
for s in "${PGTAP_SUITES[@]}" "${GATE_SUITES[@]}" "${!KNOWN_RED[@]}"; do
  CLASSIFIED["$s"]=1
done

drift=()
for f in "${TESTS_DIR}"/*.test.sql; do
  [[ -e "$f" ]] || continue
  base="$(basename "$f" .test.sql)"
  [[ -n "${CLASSIFIED[$base]:-}" ]] || drift+=("não classificada no runner: ${base}")
done
for s in "${!CLASSIFIED[@]}"; do
  [[ -f "${TESTS_DIR}/${s}.test.sql" ]] || drift+=("listada mas ausente no disco: ${s}")
done
if [[ ${#drift[@]} -gt 0 ]]; then
  echo "▸ drift entre o runner e ${TESTS_DIR}/ — corrija antes de rodar:" >&2
  printf '   - %s\n' "${drift[@]}" >&2
  echo "adicione a suíte a GATE_SUITES/KNOWN_RED (ou remova a entrada obsoleta)." >&2
  exit 1
fi

# ── Guarda 4: toda KNOWN_RED aponta para issue aberta (#650). ───────────────
# A exceção vale enquanto a issue que a rastreia está aberta; fechada a issue,
# ou a suíte foi consertada e deve ir para GATE_SUITES, ou a issue foi fechada
# sem consertar e a exceção perdeu o dono. A consulta ao GitHub é fail-open:
# sem `gh`, sem rede ou sem login, avisa e segue, para o gate local não depender
# de rede. No CI o `gh` tem o token do workflow.
KNOWN_RED_REPO=bdcdo/dataframeitGUI
fossil=()
for s in "${!KNOWN_RED[@]}"; do
  ref="${KNOWN_RED[$s]}"
  if [[ ! "$ref" =~ ^#([0-9]+)$ ]]; then
    fossil+=("${s}: '${ref}' não é referência de issue (#N)")
    continue
  fi
  state="$(gh issue view "${BASH_REMATCH[1]}" --repo "${KNOWN_RED_REPO}" --json state -q .state 2>/dev/null)"
  case "$state" in
    OPEN) ;;
    "") echo "aviso: não deu para conferir ${ref} de ${s} no GitHub (gh ausente, sem rede ou sem login); seguindo." >&2 ;;
    *) fossil+=("${s}: ${ref} está ${state}") ;;
  esac
done
if [[ ${#fossil[@]} -gt 0 ]]; then
  echo "▸ KNOWN_RED sem issue aberta — corrija antes de rodar:" >&2
  printf '   - %s\n' "${fossil[@]}" >&2
  echo "conserte a suíte e mova-a para GATE_SUITES, ou aponte a entrada para a issue aberta que a rastreia." >&2
  exit 1
fi

# Suítes pedidas na linha de comando; nenhuma = todas. Nome fora das listas é
# erro, e não um subconjunto vazio que passaria em silêncio.
declare -A SELECTED=()
for name in "$@"; do
  if [[ -z "$name" ]] || [[ -z "${CLASSIFIED[$name]:-}" && "$name" != backend_integration ]]; then
    echo "suíte desconhecida: ${name} (veja GATE_SUITES/PGTAP_SUITES/KNOWN_RED)" >&2
    exit 2
  fi
  SELECTED["$name"]=1
done
selected() { [[ ${#SELECTED[@]} -eq 0 || -n "${SELECTED[$1]:-}" ]]; }

pass=()
fail_gate=()
fail_known=()
promote=()

# Log por suíte para diagnóstico em falha (guarda 3), limpo ao sair.
LOG_DIR="$(mktemp -d)"
trap 'rm -rf "${LOG_DIR}"' EXIT

run_pgtap() {
  if [[ -n "${SUPABASE_DB_NAME:-}${SUPABASE_DB_CONTAINER:-}" ]]; then
    local port
    port="$(docker inspect -f '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' "${CONTAINER}")"
    if [[ ! "$port" =~ ^[0-9]+$ ]]; then
      echo "container sem porta PostgreSQL publicada"
      return 2
    fi
    PGPASSWORD=postgres npx supabase test db "${TESTS_DIR}/$1.test.sql" \
      --db-url "postgresql://postgres@127.0.0.1:${port}/${SUPABASE_DB_NAME:-postgres}"
  else
    npx supabase test db "${TESTS_DIR}/$1.test.sql" --local
  fi
}

run_psql() {
  bash scripts/run-sql-test.sh "${TESTS_DIR}/$1.test.sql"
}

# No GitHub Actions o database-tests.yml roda tudo num passo só, e o passo por
# suíte de antes mostrava a saída inteira de cada uma e, num travamento, qual
# estava rodando. Lá cada suíte vira um grupo, aberto antes de ela rodar e com
# a saída inteira enquanto roda, e a falha de gate vira anotação.
in_ci() { [[ ${GITHUB_ACTIONS:-} == true ]]; }

# Roda uma suíte com a saída no log dela e a reporta: gate|known, suíte, comando.
run_suite() {
  local gated="$1" suite="$2" code
  shift 2
  if in_ci; then
    echo "::group::${suite}"
    "$@" 2>&1 | tee "${LOG_DIR}/${suite}.log"
    code=${PIPESTATUS[0]}
    echo "::endgroup::"
  else
    "$@" >"${LOG_DIR}/${suite}.log" 2>&1
    code=$?
  fi
  report "${suite}" "${code}" "${gated}"
}

tail_log() {
  echo "    ── saída (cauda):"
  tail -n 15 "${LOG_DIR}/$1.log" | sed 's/^/    /'
}

report() {
  local suite="$1" code="$2" gated="$3"
  if [[ ${code} -eq 0 ]]; then
    if [[ ${gated} == known ]]; then
      # Guarda 2: órfã conhecida-vermelha passou — força a promoção.
      printf '  VERDE %s (era conhecida-vermelha %s — promova para GATE_SUITES)\n' \
        "${suite}" "${KNOWN_RED[$suite]}"
      promote+=("${suite}")
    else
      printf '  PASS  %s\n' "${suite}"
      pass+=("${suite}")
    fi
  elif [[ ${gated} == gate ]]; then
    printf '  FAIL  %s\n' "${suite}"
    fail_gate+=("${suite}")
    if in_ci; then
      echo "::error title=Suíte do banco ${suite}::falhou; saída inteira no grupo ${suite} do passo"
    else
      tail_log "${suite}"
    fi
  else
    printf '  RED*  %s (conhecida, %s)\n' "${suite}" "${KNOWN_RED[$suite]}"
    fail_known+=("${suite}")
  fi
}

if [[ ${#SELECTED[@]} -eq 0 ]]; then
  echo "▸ suítes de contrato do banco (varredura completa)"
else
  echo "▸ suítes de contrato do banco: ${!SELECTED[*]}"
fi

for s in "${PGTAP_SUITES[@]}"; do
  selected "$s" && run_suite gate "$s" run_pgtap "$s"
done
for s in "${GATE_SUITES[@]}"; do
  selected "$s" && run_suite gate "$s" run_psql "$s"
done
for s in "${!KNOWN_RED[@]}"; do
  selected "$s" && run_suite known "$s" run_psql "$s"
done
# Contrato do llm_runner em `llm_runs` (#674), pytest contra este mesmo stack.
if selected backend_integration; then
  run_suite gate backend_integration bash scripts/run-backend-integration.sh
fi

echo "────────────────────────────────────────"
printf 'PASS=%d  FAIL(gate)=%d  RED*(conhecida)=%d  VERDE(promover)=%d\n' \
  "${#pass[@]}" "${#fail_gate[@]}" "${#fail_known[@]}" "${#promote[@]}"

if [[ ${#fail_known[@]} -gt 0 ]]; then
  echo "RED* (não bloqueia; rastreada em issue): ${fail_known[*]}"
fi

status=0
if [[ ${#promote[@]} -gt 0 ]]; then
  echo "PROMOVER: ${promote[*]} ficou(ram) verde(s) — mova de KNOWN_RED para GATE_SUITES." >&2
  status=1
fi
if [[ ${#fail_gate[@]} -gt 0 ]]; then
  echo "FALHOU: ${fail_gate[*]}"
  status=1
fi
if [[ ${status} -eq 0 && ${#SELECTED[@]} -gt 0 ]]; then
  echo "OK: as suítes pedidas passaram (execução parcial)."
elif [[ ${status} -eq 0 ]]; then
  echo "OK: todas as suítes de gate passaram."
fi
exit ${status}
