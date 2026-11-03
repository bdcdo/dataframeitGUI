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
# que segue sem iniciar depois da sonda. `machine start` falha para os ids em
# START_FAILS (separados por espaço), a forma da Machine presa de 2026-08-10,
# cujo start voltava "insufficient CPUs available", e para os ids em
# START_FAILS_OTHER com START_OTHER_MESSAGE, a forma de um erro da API ou de
# lease ocupado, em que a Machine pode estar saudável.
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
  "machine start")
    echo "$*" >>"$CALLS_LOG"
    for failing in ${START_FAILS:-}; do
      if [[ "$3" == "$failing" ]]; then
        echo "could not reserve resource for machine: insufficient CPUs available" >&2
        exit 1
      fi
    done
    for failing in ${START_FAILS_OTHER:-}; do
      if [[ "$3" == "$failing" ]]; then
        echo "$START_OTHER_MESSAGE" >&2
        exit 1
      fi
    done
    ;;
  "machine clone"|"machine destroy") echo "$*" >>"$CALLS_LOG" ;;
  *) echo "flyctl inesperado: $*" >&2; exit 64 ;;
esac
EOF
# O curl falso responde conforme PROBE_OK; com PROBE_OK_FROM_CALL, passa a
# responder a partir dessa chamada, para simular a app que volta entre a
# primeira sonda e a segunda. A requisição presa a uma Machine
# (fly-force-instance-id) é a da conferência do relógio: fica registrada em
# $CALLS_LOG.clock e devolve o health com `server_time` deslocado em CLOCK_SKEW
# segundos para os ids em SKEWED_IDS, ou HEALTH_BODY quando dado.
cat >"$tmp_dir/bin/curl" <<'EOF'
#!/usr/bin/env bash
for arg in "$@"; do
  if [[ "$arg" == fly-force-instance-id:* ]]; then
    id="${arg#fly-force-instance-id: }"
    echo "$id" >>"$CALLS_LOG.clock"
    if [[ -n "${HEALTH_BODY:-}" ]]; then
      printf '%s' "$HEALTH_BODY"
      exit 0
    fi
    skew=0
    for skewed in ${SKEWED_IDS:-}; do
      [[ "$id" == "$skewed" ]] && skew="$CLOCK_SKEW"
    done
    printf '{"status":"ok","server_time":%s}' "$(($(date +%s) + skew))"
    exit 0
  fi
done
echo "curl" >>"$CALLS_LOG.curl"
if [[ -n "${PROBE_OK_FROM_CALL:-}" ]]; then
  (($(wc -l <"$CALLS_LOG.curl") >= PROBE_OK_FROM_CALL))
else
  [[ "${PROBE_OK:-1}" == "1" ]]
fi
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

# A saída do job (stdout e stderr) fica em $CALLS_LOG.out e o summary em
# $CALLS_LOG.summary, para os casos que asserem o diagnóstico.
run_vigia() {
  rm -f "$CALLS_LOG.list" "$CALLS_LOG.curl" "$CALLS_LOG.clock" "$CALLS_LOG.summary"
  : >"$CALLS_LOG"
  env \
    "PATH=$tmp_dir/bin:$PATH" \
    CALLS_LOG="$CALLS_LOG" \
    GITHUB_STEP_SUMMARY="$CALLS_LOG.summary" \
    MACHINES_JSON="$MACHINES_JSON" \
    MACHINES_AFTER_PROBE_JSON="${MACHINES_AFTER_PROBE_JSON:-}" \
    PROBE_OK="${PROBE_OK:-1}" \
    PROBE_OK_FROM_CALL="${PROBE_OK_FROM_CALL:-}" \
    START_FAILS="${START_FAILS:-}" \
    START_FAILS_OTHER="${START_FAILS_OTHER:-}" \
    START_OTHER_MESSAGE="${START_OTHER_MESSAGE:-}" \
    SKEWED_IDS="${SKEWED_IDS:-}" \
    CLOCK_SKEW="${CLOCK_SKEW:-0}" \
    HEALTH_BODY="${HEALTH_BODY:-}" \
    bash "$vigia" app-teste https://app.test/health "$@"
}

expect_success() {
  if ! run_vigia "$@" >"$CALLS_LOG.out" 2>&1; then
    echo "vigia deveria ter passado: $*" >&2
    exit 1
  fi
}

expect_failure() {
  if run_vigia "$@" >"$CALLS_LOG.out" 2>&1; then
    echo "vigia deveria ter falhado: $*" >&2
    exit 1
  fi
}

assert_contains() {
  local file="$1" expected="$2"
  if ! grep -Fq -- "$expected" "$file"; then
    printf '%s sem o trecho esperado: %s\nobtido:\n%s\n' "$file" "$expected" "$(cat "$file" 2>/dev/null)" >&2
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

# Crash em loop que esgotou os restarts (Machine "stopped") na SEGUNDA
# Machine: recria, e prova que a regra olha todas, não só .[0].
MACHINES_JSON="$(machines "$(machine m1)" "$(machine m2 stopped "$recent_loop")")"
expect_failure
assert_calls "machine clone m2 -a app-teste --region gru
machine destroy m2 -a app-teste --force"

# Os mesmos três crashes com a Machine "started": ela voltou a subir e pode
# estar no meio de uma run da API; o vigia não a derruba.
MACHINES_JSON="$(machines "$(machine m1)" "$(machine m2 started "$recent_loop")")"
expect_success
assert_calls ""

# Pausa e retomada no formato lido em produção, três vezes na janela, com a
# Machine suspensa: não é "exit", não é crash, nada a recriar.
suspend_cycle() {
  local at="$1"
  printf '{"type":"suspension","status":"suspending","source":"user","timestamp":%s},' "$at"
  printf '{"type":"suspension","status":"suspended","source":"flyd","timestamp":%s},' "$at"
  printf '{"type":"start","status":"starting","source":"proxy","timestamp":%s},' "$at"
  printf '{"type":"start","status":"started","source":"flyd","request":{},"timestamp":%s}' "$at"
}
suspend_resume="$(suspend_cycle "$(minutes_ago 2)"),$(suspend_cycle "$(minutes_ago 5)"),$(suspend_cycle "$(minutes_ago 9)")"
MACHINES_JSON="$(machines "$(machine m1 suspended "$suspend_resume")")"
expect_success
assert_calls ""

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
MACHINES_JSON="$(machines "$(machine m1)" "$(machine m2 suspended)")"
PROBE_OK=1
expect_success probe
assert_calls ""

# Sonda verde sem Machine iniciada, ou com a segunda listagem quebrada: o
# relógio não foi conferido, e isso reprova em vez de passar calado.
MACHINES_JSON="$(machines "$(machine m1 suspended)" "$(machine m2 stopped)")"
expect_failure probe
assert_calls ""
assert_contains "$CALLS_LOG.summary" "não foi possível listar Machines iniciadas"
MACHINES_JSON="$(machines "$(machine m1)")"
MACHINES_AFTER_PROBE_JSON="Error: 502 from API"
expect_failure probe
assert_calls ""
assert_contains "$CALLS_LOG.summary" "não foi possível listar Machines iniciadas"
unset MACHINES_AFTER_PROBE_JSON

# Relógio: cada Machine iniciada é conferida, presa pelo id, e só elas.
MACHINES_JSON="$(machines "$(machine m1)" "$(machine m2)" "$(machine m3 stopped)")"
expect_success probe
assert_calls ""
if [[ "$(paste -sd' ' "$CALLS_LOG.clock")" != "m1 m2" ]]; then
  echo "o relógio tem de ser conferido em m1 e m2, presas pelo id: $(cat "$CALLS_LOG.clock")" >&2
  exit 1
fi
# A forma de 2026-11-03: a SEGUNDA Machine com o relógio quase 11 h atrás.
# Falha e avisa, sem recriar nada. Um atraso dentro da folga passa, e o
# adiantado reprova como o atrasado.
SKEWED_IDS="m2"
for CLOCK_SKEW in -38996 120; do
  expect_failure probe
  assert_calls ""
  assert_contains "$CALLS_LOG.summary" "relógio da Machine m2 difere do runner"
done
CLOCK_SKEW=-5
expect_success probe
SKEWED_IDS=""
CLOCK_SKEW=0
# Health sem server_time (versão anterior da app) também reprova.
HEALTH_BODY='{"status":"ok"}'
expect_failure probe
assert_contains "$CALLS_LOG.summary" "não informou server_time"
unset HEALTH_BODY
# Sem sonda, o relógio não é conferido.
expect_success
if [[ -s "$CALLS_LOG.clock" ]]; then
  echo "o modo sem sonda não confere relógio" >&2
  exit 1
fi

# Sonda vermelha e uma Machine suspensa que recusa o start: é a presa.
PROBE_OK=0
MACHINES_AFTER_PROBE_JSON="$(machines "$(machine m1)" "$(machine m2 suspended)")"
START_FAILS="m2"
expect_failure probe
assert_calls "machine start m2 -a app-teste
machine clone m2 -a app-teste --region gru
machine destroy m2 -a app-teste --force"
START_FAILS=""

# Start recusado por erro da API ou por lease ocupado, sonda vermelha: a
# Machine pode estar saudável, e recriá-la derrubaria a app à toa. Avisa,
# falha e não recria nada; o stderr do flyctl chega ao log do job.
START_FAILS_OTHER="m2"
for START_OTHER_MESSAGE in \
  "failed to start: 503 Service Unavailable" \
  "Error: lease currently held by another process"
do
  expect_failure probe
  assert_calls "machine start m2 -a app-teste"
  assert_contains "$CALLS_LOG.out" "$START_OTHER_MESSAGE"
  assert_contains "$CALLS_LOG.summary" "não é capacidade do host"
done
START_FAILS_OTHER=""
unset START_OTHER_MESSAGE

# Start aceito e a segunda sonda verde (as três chamadas da primeira falham,
# a quarta responde): o start manual trouxe a app de volta. Nada recriado,
# mas o job falha, porque o proxy não religou a app sozinho.
PROBE_OK_FROM_CALL=4
expect_failure probe
assert_calls "machine start m2 -a app-teste"
assert_contains "$CALLS_LOG.summary" "health voltou depois do start manual"
unset PROBE_OK_FROM_CALL

# m1 de pé com health vermelho e m2 suspensa que inicia: a suspensa é a pausa
# legítima do tráfego baixo, não a causa. Avisa, falha e não recria nada.
expect_failure probe
assert_calls "machine start m2 -a app-teste"
assert_contains "$CALLS_LOG.summary" "defeito fora do host"

# As duas suspensas, os dois starts aceitos, sonda vermelha: é a forma de uma
# falha de rede do runner ou da borda. Não recria nada.
MACHINES_AFTER_PROBE_JSON="$(machines "$(machine m1 suspended)" "$(machine m2 suspended)")"
expect_failure probe
assert_calls "machine start m1 -a app-teste
machine start m2 -a app-teste"

# Sonda vermelha com todas iniciadas: nada a religar nem a recriar; avisa.
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
  # As passadas sem sonda são as frequentes, de vários minutos por hora; a
  # horária, com sonda, tem um minuto só. A expressão inteira é comparada, e não
  # só a presença do cron, para que trocar `!=` por `==` (sonda em toda passada
  # frequente e nunca na horária) reprove.
  no_probe_cron = crons.find { |c| c.split.first.include?(",") }
  abort("sem o agendamento frequente, sem sonda") unless no_probe_cron
  # \x27 é a aspa simples, que não cabe literal dentro do script entre aspas
  # simples do bash.
  q = "\x27"
  expected_mode = "${{ github.event.schedule != #{q}#{no_probe_cron}#{q} && #{q}probe#{q} || #{q}#{q} }}"
  jobs = workflow.fetch("jobs")
  # A URL é comparada inteira, na posição do argumento: a sonda tem de ir ao
  # hostname .fly.dev de cada app, e não ao domínio próprio nem à outra app.
  {
    "frontend" => ["fly-deploy-frontend", "gui-analise-sistematica-frontend", "https://gui-analise-sistematica-frontend.fly.dev/api/health", "FLY_API_TOKEN_FRONTEND"],
    "api" => ["fly-deploy-backend", "gui-analise-sistematica-api", "https://gui-analise-sistematica-api.fly.dev/health", "FLY_API_TOKEN }}"],
  }.each do |name, (group, app, url, token)|
    job = jobs.fetch(name)
    abort("#{name}: fora da fila do deploy") unless job.fetch("concurrency").fetch("group") == group
    step = job.fetch("steps").find { |s| s["run"]&.include?("fly-vigia.sh") }
    abort("#{name}: sem passo do vigia") unless step
    args = step["run"].split
    abort("#{name}: app errada: #{args[2]}") unless args[2] == app
    abort("#{name}: URL de health errada: #{args[3]}") unless args[3] == url
    abort("#{name}: token errado") unless step.fetch("env").fetch("FLY_API_TOKEN").include?(token)
    probe = step.fetch("env").fetch("VIGIA_MODO")
    abort("#{name}: a sonda tem de depender do agendamento: #{probe}") unless probe == expected_mode
  end
' "$workflow"

echo "Vigia das Machines validado."
