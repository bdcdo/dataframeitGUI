#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
vigia="$repo_root/.github/scripts/fly-vigia.sh"
workflow="$repo_root/.github/workflows/fly-vigia.yml"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
mkdir -p "$tmp_dir/bin"

# O flyctl falso registra toda chamada que muda produção em $CALLS_LOG; é o que
# os casos asserem. `machine list` devolve MACHINES_JSON na primeira chamada e
# MACHINES_AFTER_PROBE_JSON (quando dado) nas seguintes, para simular a Machine
# que segue sem iniciar depois da sonda.
cat >"$tmp_dir/bin/flyctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

case "${1:-} ${2:-}" in
  "machine list")
    count_file="$CALLS_LOG.list"
    count="$(cat "$count_file" 2>/dev/null || echo 0)"
    echo "$((count + 1))" >"$count_file"
    if [[ "$count" -gt 0 && -n "${MACHINES_AFTER_PROBE_JSON:-}" ]]; then
      printf '%s' "$MACHINES_AFTER_PROBE_JSON"
    else
      printf '%s' "$MACHINES_JSON"
    fi
    ;;
  "machine clone"|"machine destroy") echo "$*" >>"$CALLS_LOG" ;;
  *) echo "flyctl inesperado: $*" >&2; exit 64 ;;
esac
EOF
cat >"$tmp_dir/bin/curl" <<'EOF'
#!/usr/bin/env bash
echo "curl" >>"$CALLS_LOG.curl"
[[ "${PROBE_OK:-1}" == "1" ]]
EOF
cat >"$tmp_dir/bin/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$tmp_dir/bin/flyctl" "$tmp_dir/bin/curl" "$tmp_dir/bin/sleep"

now_ms="$(($(date +%s) * 1000))"
minutes_ago() { echo "$((now_ms - $1 * 60 * 1000))"; }

# exit_event sem requested_stop reproduz o abort do Node de 2026-11-01; o
# terceiro argumento força requested_stop=true, a forma de deploy e escala.
exit_event() {
  local at="$1" requested="${2:-}"
  if [[ -n "$requested" ]]; then
    printf '{"type":"exit","status":"stopped","timestamp":%s,"request":{"exit_event":{"exit_code":0,"requested_stop":true}}}' "$at"
  else
    printf '{"type":"exit","status":"stopped","timestamp":%s,"request":{"exit_event":{"exit_code":134}}}' "$at"
  fi
}

machine() {
  local id="$1" state="${2:-started}" events="${3:-}"
  printf '{"id":"%s","state":"%s","region":"gru","events":[%s]}' "$id" "$state" "$events"
}

machines() {
  local IFS=','
  printf '[%s]' "$*"
}

run_vigia() {
  rm -f "$CALLS_LOG.list" "$CALLS_LOG.curl"
  : >"$CALLS_LOG"
  env \
    "PATH=$tmp_dir/bin:$PATH" \
    CALLS_LOG="$CALLS_LOG" \
    MACHINES_JSON="$MACHINES_JSON" \
    MACHINES_AFTER_PROBE_JSON="${MACHINES_AFTER_PROBE_JSON:-}" \
    PROBE_OK="${PROBE_OK:-1}" \
    bash "$vigia" app-teste https://app.test/health "$@"
}

expect_success() {
  if ! run_vigia "$@" >/dev/null 2>&1; then
    echo "vigia deveria ter passado: $*" >&2
    exit 1
  fi
}

expect_failure() {
  if run_vigia "$@" >/dev/null 2>&1; then
    echo "vigia deveria ter falhado: $*" >&2
    exit 1
  fi
}

assert_calls() {
  local expected="$1" actual
  actual="$(cat "$CALLS_LOG")"
  if [[ "$actual" != "$expected" ]]; then
    printf 'chamadas ao flyctl divergentes\nesperado:\n%s\nobtido:\n%s\n' "$expected" "$actual" >&2
    exit 1
  fi
}

assert_no_probe() {
  if [[ -s "$CALLS_LOG.curl" ]]; then
    echo "o modo sem sonda não pode acordar a app" >&2
    exit 1
  fi
}

CALLS_LOG="$tmp_dir/calls"
bash -n "$vigia" "$0"

recent_loop="$(exit_event "$(minutes_ago 2)"),$(exit_event "$(minutes_ago 5)"),$(exit_event "$(minutes_ago 9)")"

# Saudável, pausada ou parada sem crash: nada a fazer, e sem sonda nada toca a app.
MACHINES_JSON="$(machines "$(machine m1)" "$(machine m2 suspended)" "$(machine m3 stopped)")"
expect_success
assert_calls ""
assert_no_probe

# Estado failed: recria.
MACHINES_JSON="$(machines "$(machine m1)" "$(machine m2 failed)")"
expect_failure
assert_calls "machine clone m2 -a app-teste --region gru
machine destroy m2 -a app-teste --force"

# Crash em loop na SEGUNDA Machine: prova que a regra olha todas, não só .[0].
MACHINES_JSON="$(machines "$(machine m1)" "$(machine m2 started "$recent_loop")")"
expect_failure
assert_calls "machine clone m2 -a app-teste --region gru
machine destroy m2 -a app-teste --force"

# Abaixo do limiar, fora da janela ou pedido por deploy: não é loop.
two_recent="$(exit_event "$(minutes_ago 2)"),$(exit_event "$(minutes_ago 5)")"
old_three="$(exit_event "$(minutes_ago 40)"),$(exit_event "$(minutes_ago 45)"),$(exit_event "$(minutes_ago 50)")"
requested_three="$(exit_event "$(minutes_ago 2)" requested),$(exit_event "$(minutes_ago 5)" requested),$(exit_event "$(minutes_ago 9)" requested)"
for events in "$two_recent" "$old_three" "$requested_three"; do
  MACHINES_JSON="$(machines "$(machine m1 started "$events")")"
  expect_success
  assert_calls ""
done

# Sonda verde: nada a fazer.
MACHINES_JSON="$(machines "$(machine m1 suspended)" "$(machine m2 suspended)")"
PROBE_OK=1
expect_success probe
assert_calls ""

# Sonda vermelha e uma Machine que não saiu de suspended: é a presa.
PROBE_OK=0
MACHINES_AFTER_PROBE_JSON="$(machines "$(machine m1)" "$(machine m2 suspended)")"
expect_failure probe
assert_calls "machine clone m2 -a app-teste --region gru
machine destroy m2 -a app-teste --force"

# Sonda vermelha com todas iniciadas: defeito da aplicação; avisa e não recria.
MACHINES_AFTER_PROBE_JSON="$(machines "$(machine m1)" "$(machine m2)")"
expect_failure probe
assert_calls ""
unset MACHINES_AFTER_PROBE_JSON
PROBE_OK=1

# Resposta fora do formato: recusa sem agir.
MACHINES_JSON='{"unexpected":"shape"}'
expect_failure
assert_calls ""

# Argumentos inválidos.
MACHINES_JSON='[]'
expect_failure sonda
if env "PATH=$tmp_dir/bin:$PATH" bash "$vigia" >/dev/null 2>&1; then
  echo "vigia sem argumentos deveria recusar" >&2
  exit 1
fi

# O workflow: sonda só no agendamento horário, e cada app na mesma fila de
# concorrência do seu deploy, para o vigia nunca ler as Machines transitórias
# de um bluegreen em curso e "consertar" uma delas.
ruby -ryaml -e '
  workflow = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: true)
  trigger = workflow["on"] || workflow[true]
  crons = trigger.fetch("schedule").map { |entry| entry.fetch("cron") }
  abort("vigia precisa de dois agendamentos: com e sem sonda") unless crons.length == 2
  jobs = workflow.fetch("jobs")
  {
    "frontend" => ["fly-deploy-frontend", "gui-analise-sistematica-frontend", "FLY_API_TOKEN_FRONTEND"],
    "api" => ["fly-deploy-backend", "gui-analise-sistematica-api", "FLY_API_TOKEN }}"],
  }.each do |name, (group, app, token)|
    job = jobs.fetch(name)
    abort("#{name}: fora da fila do deploy") unless job.fetch("concurrency").fetch("group") == group
    step = job.fetch("steps").find { |s| s["run"]&.include?("fly-vigia.sh") }
    abort("#{name}: sem passo do vigia") unless step
    abort("#{name}: app errada") unless step["run"].include?(app)
    abort("#{name}: token errado") unless step.fetch("env").fetch("FLY_API_TOKEN").include?(token)
    probe = step.fetch("env").fetch("VIGIA_MODO")
    abort("#{name}: a sonda tem de depender do agendamento") unless crons.any? { |c| probe.include?(c) }
  end
' "$workflow"

echo "Vigia das Machines validado."
