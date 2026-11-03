#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
checker="$repo_root/.github/scripts/check-backend-fly-machines.sh"
workflow="$repo_root/.github/workflows/fly-deploy.yml"
fly_config="$repo_root/backend/fly.toml"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
mkdir -p "$tmp_dir/bin"

cat >"$tmp_dir/bin/flyctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

case "${1:-} ${2:-}" in
  "machine list") printf '%s' "$MACHINES_JSON" ;;
  "checks list") printf '%s' "$CHECKS_JSON" ;;
  *) echo "flyctl inesperado: $*" >&2; exit 64 ;;
esac
EOF
chmod +x "$tmp_dir/bin/flyctl"
cat >"$tmp_dir/bin/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$tmp_dir/bin/sleep"

machine() {
  local state="${1:-started}"
  local region="${2:-gru}"
  local cpu_kind="${3:-shared}"
  local cpus="${4:-1}"
  local memory_mb="${5:-512}"
  local autostop="${6:-false}"
  local autostart="${7:-true}"
  printf '[{"id":"machine-1","state":"%s","region":"%s","config":{"guest":{"cpu_kind":"%s","cpus":%s,"memory_mb":%s},"services":[{"internal_port":8000,"autostop":%s,"autostart":%s}]}}]' \
    "$state" "$region" "$cpu_kind" "$cpus" "$memory_mb" "$autostop" "$autostart"
}

run_checker() {
  env \
    "PATH=$tmp_dir/bin:$PATH" \
    MACHINES_JSON="$MACHINES_JSON" \
    CHECKS_JSON="$CHECKS_JSON" \
    bash "$checker" "$1"
}

expect_failure() {
  if "$@" >/dev/null 2>&1; then
    echo "comando deveria ter falhado: $*" >&2
    exit 1
  fi
}

bash -n "$checker" "$0"

# O preflight aceita somente os estados dos quais --ha=false converge para uma
# única Machine. Mais de uma exige redução remota explícita antes do deploy.
MACHINES_JSON='[]'
CHECKS_JSON='{}'
run_checker pre >/dev/null
MACHINES_JSON="$(machine)"
run_checker pre >/dev/null
MACHINES_JSON="[$(machine | sed 's/^\[//; s/\]$//'),$(machine | sed 's/^\[//; s/\]$//')]"
expect_failure run_checker pre
MACHINES_JSON='{"unexpected":"shape"}'
expect_failure run_checker pre

# O postflight exige a topologia versionada e ao menos um health check verde.
MACHINES_JSON="$(machine)"
CHECKS_JSON='{"machine-1":[{"name":"servicecheck-00-http-8000","status":"passing"}]}'
run_checker pre >/dev/null
run_checker post >/dev/null

for invalid_machine in \
  "$(machine stopped)" \
  "$(machine started iad)" \
  "$(machine started gru performance)" \
  "$(machine started gru shared 2)" \
  "$(machine started gru shared 1 1024)" \
  "$(machine started gru shared 1 512 '"suspend"')" \
  "$(machine started gru shared 1 512 '"stop"')" \
  "$(machine started gru shared 1 512 true)" \
  "$(machine started gru shared 1 512 null)" \
  "$(machine started gru shared 1 512 false false)" \
  "$(machine | jq -c '.[0].config.services = []')" \
  "$(machine | jq -c 'del(.[0].config.services)')"
do
  MACHINES_JSON="$invalid_machine"
  expect_failure run_checker post
done

MACHINES_JSON="$(machine)"
CHECKS_JSON='{}'
expect_failure run_checker post
CHECKS_JSON='{"machine-1":[{"name":"servicecheck-00-http-8000","status":"critical"}]}'
expect_failure run_checker post

# O workflow usa o mesmo contrato executável antes e depois do deploy e nunca
# permite que o default de alta disponibilidade recrie a segunda Machine.
ruby -ryaml -e '
  workflow = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: true)
  trigger = workflow["on"] || workflow[true]
  paths = trigger.fetch("push").fetch("paths")
  abort("mudança no checker precisa disparar o workflow") unless paths.include?(".github/scripts/check-backend-fly-machines.sh")
  steps = workflow.fetch("jobs").fetch("deploy").fetch("steps")
  runs = steps.filter_map { |step| step["run"] }
  pre = runs.index { |run| run.include?("check-backend-fly-machines.sh pre") }
  # A espera pelas runs vem antes do deploy: trocar a Machine no meio de uma
  # run de horas mata o job, e o kill_timeout de 5 min não a cobre.
  wait_jobs = runs.index { |run| run.include?("active_jobs") }
  abort("workflow sem esperar as runs antes do deploy") unless wait_jobs
  # O build vem antes da espera, e o deploy só implanta a imagem pronta: com
  # build e troca no mesmo comando, uma run iniciada durante os minutos de
  # build morreria na troca, depois de a espera já ter visto zero runs.
  build = runs.index { |run| run.include?("flyctl deploy") && run.include?("--build-only") }
  deploy = runs.index { |run| run.include?("flyctl deploy") && run.include?("--ha=false") }
  post = runs.index { |run| run.include?("check-backend-fly-machines.sh post") }
  abort("workflow sem passo de build separado") unless build
  abort("workflow sem ordem preflight -> deploy -> postflight") unless pre && deploy && post && pre < deploy && deploy < post
  abort("workflow sem ordem build -> espera -> deploy") unless build < wait_jobs && wait_jobs < deploy
  build_run = runs.fetch(build)
  deploy_run = runs.fetch(deploy)
  ["--push", "--remote-only", "--image-label \"deploy-${GITHUB_SHA}\"", "-a gui-analise-sistematica-api"].each do |arg|
    abort("build sem #{arg}") unless build_run.include?(arg)
  end
  # O deploy pede a imagem pelo mesmo rótulo do build; sem `--image`, o flyctl
  # construiria de novo e a janela do build voltaria.
  ["--image \"registry.fly.io/gui-analise-sistematica-api:deploy-${GITHUB_SHA}\"", "-a gui-analise-sistematica-api"].each do |arg|
    abort("deploy sem #{arg}") unless deploy_run.include?(arg)
  end
  [build, deploy].each do |index|
    step = steps.select { |s| s["run"] }.fetch(index)
    abort("#{step["name"]}: precisa rodar em backend, onde está o fly.toml") unless step["working-directory"] == "backend"
  end
  wait_step = steps.select { |s| s["run"] }.fetch(wait_jobs)
  # Sem `shell: bash` explícito o Actions roda `bash -e` sem pipefail.
  abort("a espera precisa de shell: bash (pipefail)") unless wait_step["shell"] == "bash"
  abort("timeout da espera abaixo do prazo de 4 h") unless wait_step.fetch("timeout-minutes") > 240
' "$workflow"

# Comportamento da espera: o `run` do passo é extraído do YAML e executado com
# curl e sleep falsos e o `date` real, na mesma invocação que o Actions usa para
# `shell: bash`. CURL_RESPONSES é uma linha por chamada: "FAIL" faz o curl sair
# 22 (a forma do 502 com -f); qualquer outra linha, inclusive vazia, sai no
# stdout com status 0.
wait_script="$tmp_dir/wait-jobs.sh"
ruby -ryaml -e '
  workflow = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: true)
  step = workflow.fetch("jobs").fetch("deploy").fetch("steps").find { |s| s["run"]&.include?("active_jobs") }
  File.write(ARGV.fetch(1), step.fetch("run"))
' "$workflow" "$wait_script"

wait_bin="$tmp_dir/wait-bin"
mkdir -p "$wait_bin"
cat >"$wait_bin/curl" <<'EOF'
#!/usr/bin/env bash
count="$(cat "$WAIT_LOG.curl" 2>/dev/null || echo 0)"
echo "$((count + 1))" >"$WAIT_LOG.curl"
line="$(sed -n "$((count + 1))p" "$CURL_RESPONSES")"
if [[ "$line" == "FAIL" ]]; then
  exit 22
fi
printf '%s' "$line"
EOF
cat >"$wait_bin/sleep" <<'EOF'
#!/usr/bin/env bash
echo "$1" >>"$WAIT_LOG.sleep"
EOF
chmod +x "$wait_bin/curl" "$wait_bin/sleep"

run_wait() {
  printf '%s\n' "$@" >"$tmp_dir/curl-responses"
  rm -f "$tmp_dir/wait.curl" "$tmp_dir/wait.sleep"
  touch "$tmp_dir/wait.sleep"
  if ! wait_output="$(env "PATH=$wait_bin:$PATH" WAIT_LOG="$tmp_dir/wait" CURL_RESPONSES="$tmp_dir/curl-responses" \
    timeout 20 bash --noprofile --norc -eo pipefail "$wait_script" 2>&1)"; then
    printf 'a espera falhou ou estourou o tempo:\n%s\n' "$wait_output" >&2
    exit 1
  fi
}

assert_wait() {
  local expected_message="$1" expected_sleeps="$2" actual_sleeps
  actual_sleeps="$(paste -sd' ' "$tmp_dir/wait.sleep")"
  if [[ "$wait_output" != *"$expected_message"* || "$actual_sleeps" != "$expected_sleeps" ]]; then
    printf 'espera divergente\nesperado: "%s", sleeps "%s"\nobtido: sleeps "%s"\n%s\n' \
      "$expected_message" "$expected_sleeps" "$actual_sleeps" "$wait_output" >&2
    exit 1
  fi
}

# Nenhuma run: sai na hora.
run_wait '{"status":"ok","active_jobs":0}'
assert_wait "Nenhuma run em curso." ""
# Duas runs, depois nenhuma: espera uma volta e sai.
run_wait '{"status":"ok","active_jobs":2}' '{"status":"ok","active_jobs":0}'
assert_wait "Nenhuma run em curso." "60"
# Versão anterior da API, sem o campo: conta como zero.
run_wait '{"status":"ok"}'
assert_wait "Nenhuma run em curso." ""
# Três leituras falhas seguidas: API fora do ar, nada a esperar.
run_wait FAIL FAIL FAIL
assert_wait "API sem resposta" "10 10"
# Corpo vazio com status 0, a forma em que jq 1.6 com `-e` sai 0 sem imprimir
# nada: conta como leitura falha, e não como run em curso.
run_wait '' '' ''
assert_wait "API sem resposta" "10 10"
# Um 502 transitório não encerra a espera com run ativa.
run_wait FAIL '{"status":"ok","active_jobs":1}' '{"status":"ok","active_jobs":0}'
assert_wait "Nenhuma run em curso." "10 60"

grep -Fq 'size = "shared-cpu-1x"' "$fly_config"
grep -Fq 'memory = "512mb"' "$fly_config"
# Mesma comparação por linha inteira, sem comentários, do contrato do frontend:
# o arquivo cita em prosa formas que estas asserções rejeitam.
fly_directives="$(sed 's/#.*//; s/[[:space:]]*$//; s/^[[:space:]]*//' "$fly_config")"
for directive in 'auto_stop_machines = "off"' 'auto_start_machines = true' 'min_machines_running = 1'; do
  grep -Fxq "$directive" <<<"$fly_directives" || { echo "backend/fly.toml sem a diretiva esperada: $directive" >&2; exit 1; }
done
# Nenhuma forma de scale-to-zero: "stop" derrubou o site em 2026-08-10 e
# "suspend" em 2026-11-03 (motivos no comentário do auto_stop_machines em
# frontend/fly.toml). Toda linha de auto_stop_machines, inclusive num bloco
# [[services]] separado que a asserção acima não vê, tem de ser "off" ou false.
# Lista do que se aceita, e não do que se proíbe: o flyctl também lê 'stop'
# (string literal do TOML) e true (o stop legado), e uma lista de proibidos
# deixava as duas passarem.
if grep -E '^auto_stop_machines[[:space:]]*=' <<<"$fly_directives" \
  | grep -Evxq 'auto_stop_machines[[:space:]]*=[[:space:]]*("off"|false)'; then
  echo "backend/fly.toml com scale-to-zero: todo auto_stop_machines tem de ser \"off\"" >&2
  exit 1
fi

echo "Contrato de Machines do backend validado."
