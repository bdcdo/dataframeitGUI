#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
checker="$repo_root/.github/scripts/check-backend-fly-machines.sh"
workflow="$repo_root/.github/workflows/fly-deploy.yml"
vigia_workflow="$repo_root/.github/workflows/fly-vigia.yml"
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
# permite que o default de alta disponibilidade recrie a segunda Machine. O
# segundo argumento, opcional, substitui o timeout-minutes da espera para testar
# o piso sem editar o workflow.
#
# Filas (#840): o deploy espera as runs de LLM por até 4 h, e o vigia da API
# divide com ele um grupo de concorrência. A espera longa fica num job fora
# desse grupo; dentro dele ficam só a releitura das runs, o preflight, o deploy
# e o postflight.
check_workflow() {
  ruby -ryaml -e '
  workflow = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: true)
  vigia = YAML.safe_load(File.read(ENV.fetch("VIGIA_WORKFLOW")), aliases: true)
  trigger = workflow["on"] || workflow[true]
  paths = trigger.fetch("push").fetch("paths")
  abort("mudança no checker precisa disparar o workflow") unless paths.include?(".github/scripts/check-backend-fly-machines.sh")
  jobs = workflow.fetch("jobs")
  prepare_job = jobs["prepare"] or abort("workflow sem o job prepare: a espera das runs não pode ficar no job que segura a fila do vigia da API")
  deploy_job = jobs.fetch("deploy")
  # O grupo do vigia é lido do fly-vigia.yml, e não repetido aqui: o que
  # importa é o deploy e o vigia da API estarem no mesmo.
  machines_queue = vigia.fetch("jobs").fetch("api").fetch("concurrency")
  # Vale para os dois lados da fila: com cancelamento ou sem `queue: max`, uma
  # passada do vigia tiraria da fila um deploy pendente, e vice-versa.
  abort("a fila do vigia da API não pode cancelar nem descartar pendente") unless machines_queue.slice("cancel-in-progress", "queue") == { "cancel-in-progress" => false, "queue" => "max" }
  abort("o job deploy precisa da fila do vigia da API, sem cancelar e sem descartar pendente") unless deploy_job["concurrency"] == machines_queue
  # Só o job deploy entra em grupo: o prepare (build e espera de até 4 h) ou
  # qualquer job novo no grupo do vigia o deixaria na fila de novo.
  jobs.each do |id, job|
    abort("o job #{id} não pode ter grupo de concorrência: só o deploy divide a fila com o vigia da API") if id != "deploy" && job.key?("concurrency")
  end
  # O grupo do workflow vale para todos os jobs, o prepare inclusive; com o
  # nome do grupo do vigia, a espera voltaria para a fila dele.
  pipeline_group = workflow.fetch("concurrency").fetch("group")
  # O Actions compara nome de grupo sem distinguir maiúsculas de minúsculas.
  abort("o grupo do workflow não pode ser o do vigia da API") if pipeline_group.casecmp?(machines_queue.fetch("group"))
  # Com expressão no nome (o id da run, o SHA), cada deploy teria o seu grupo
  # e a fila entre eles acabaria.
  abort("o grupo do workflow tem de ser um nome fixo") if pipeline_group.include?("${{")
  # Job pulado não é falha: o deploy deixaria de acontecer sem abrir incidente.
  [prepare_job, deploy_job].each do |job|
    abort("os jobs prepare e deploy não podem ter if nem continue-on-error") if job.key?("if") || job.key?("continue-on-error")
    # O piso de 245 min é do passo da espera; um teto no job o mataria no meio
    # dela, ou entre a releitura e a troca.
    abort("os jobs prepare e deploy não podem ter timeout-minutes próprio") if job.key?("timeout-minutes")
  end
  # Que esse grupo não cancela nem descarta deploy pendente está em
  # test-deploy-failure-notification.sh.
  abort("o job deploy precisa vir depois do prepare") unless Array(deploy_job["needs"]) == ["prepare"]
  # Passos dos dois jobs na ordem em que rodam, cada um com o job de origem.
  steps = [prepare_job, deploy_job].flat_map { |job| job.fetch("steps").map { |step| step.merge("job" => job) } }.select { |s| s["run"] }
  runs = steps.map { |step| step["run"] }
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
    step = steps.fetch(index)
    abort("#{step["name"]}: precisa rodar em backend, onde está o fly.toml") unless step["working-directory"] == "backend"
  end
  wait_step = steps.fetch(wait_jobs)
  abort("o build e a espera longa ficam no job prepare") unless [build, wait_jobs].all? { |index| steps.fetch(index)["job"].equal?(prepare_job) }
  abort("preflight, deploy e postflight ficam no job deploy") unless [pre, deploy, post].all? { |index| steps.fetch(index)["job"].equal?(deploy_job) }
  # Entre o fim da espera e a troca passam a subida do runner do segundo job
  # e, no pior caso, uma passada do vigia. O job deploy relê as runs já dentro
  # da fila, com o mesmo passo, para a troca vir logo depois de uma leitura.
  recheck = steps.index { |step| step["job"].equal?(deploy_job) && step["run"].include?("active_jobs") }
  abort("o job deploy precisa reler as runs antes do preflight") unless recheck && recheck < pre
  abort("a releitura das runs tem de ser o mesmo passo da espera") unless steps.fetch(recheck).except("job") == wait_step.except("job")
  # Dentro da fila do vigia só cabem estes quatro passos, mais o checkout e o
  # setup do flyctl: qualquer outro trabalho ali é tempo da API sem vigia.
  deploy_steps = deploy_job.fetch("steps")
  abort("o job deploy só pode ter checkout, setup do flyctl, releitura, preflight, deploy e postflight") unless deploy_steps.size == 6 && deploy_steps.count { |step| step["run"] } == 4
  # A releitura usa o prazo que o prepare calculou, e não outras 4 h: sem
  # isso, uma run mais longa que o prazo seria esperada de novo dentro da fila.
  # A comparação é com a string literal da expressão do Actions.
  abort("o prepare precisa publicar o prazo da espera") unless wait_step["id"] == "wait_llm_runs" && prepare_job.dig("outputs", "wait_deadline") == "${{ steps.wait_llm_runs.outputs.deadline }}"
  abort("o job deploy precisa receber o prazo do prepare em WAIT_DEADLINE") unless deploy_job.dig("env", "WAIT_DEADLINE") == "${{ needs.prepare.outputs.wait_deadline }}"
  abort("o prepare não pode receber WAIT_DEADLINE: é ele que calcula o prazo") if [workflow, prepare_job, wait_step].any? { |scope| scope.fetch("env", {}).key?("WAIT_DEADLINE") }
  # Sem `shell: bash` explícito o Actions roda `bash -e` sem pipefail.
  abort("a espera precisa de shell: bash (pipefail)") unless wait_step["shell"] == "bash"
  # Depois do prazo de 4 h cabe mais uma volta da espera, de cerca de 4,5 min
  # (conta no comentário do passo em fly-deploy.yml): abaixo de 245 o Actions
  # mataria o passo antes de ela terminar.
  timeout = ARGV[1] ? Integer(ARGV[1]) : wait_step.fetch("timeout-minutes")
  abort("timeout da espera abaixo de 4 h mais a última volta (245 min)") unless timeout >= 245
' "$@"
}

export VIGIA_WORKFLOW="$vigia_workflow"
check_workflow "$workflow"
# O piso é 245, e não só "acima de 240".
expect_failure check_workflow "$workflow" 244
check_workflow "$workflow" 245

# Casos vermelhos das filas. Cada um reescreve o workflow com uma mudança só e
# tem de reprovar pela mensagem da regra, e não por outro motivo.
expect_queue_failure() {
  local expected_message="$1" mutation="$2" output
  ruby -ryaml -e '
    workflow = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: true)
    jobs = workflow.fetch("jobs")
    machines_queue = jobs.fetch("deploy").fetch("concurrency")
    eval(ARGV.fetch(2))
    File.write(ARGV.fetch(1), YAML.dump(workflow))
  ' "$workflow" "$tmp_dir/mutated-workflow.yml" "$mutation"
  if output="$(check_workflow "$tmp_dir/mutated-workflow.yml" 2>&1)"; then
    echo "o contrato das filas deveria reprovar: $mutation" >&2
    exit 1
  fi
  [[ $output == *"$expected_message"* ]] || { printf 'reprovou por outro motivo: %s\n%s\n' "$mutation" "$output" >&2; exit 1; }
}

# A forma anterior ao #840: o workflow inteiro, espera inclusive, na fila do vigia.
expect_queue_failure "o grupo do workflow não pode ser o do vigia" 'workflow["concurrency"] = machines_queue'
expect_queue_failure "o job prepare não pode ter grupo" 'jobs["prepare"]["concurrency"] = machines_queue'
expect_queue_failure "o job notify-failure não pode ter grupo" 'jobs["notify-failure"]["concurrency"] = machines_queue'
expect_queue_failure "o grupo do workflow tem de ser um nome fixo" 'workflow["concurrency"]["group"] += "-${{ github.run_id }}"'
expect_queue_failure "os jobs prepare e deploy não podem ter if" 'jobs["deploy"]["if"] = "false"'
expect_queue_failure "os jobs prepare e deploy não podem ter if" 'jobs["prepare"]["continue-on-error"] = true'
expect_queue_failure "os jobs prepare e deploy não podem ter timeout-minutes" 'jobs["prepare"]["timeout-minutes"] = 60'
expect_queue_failure "o grupo do workflow não pode ser o do vigia" 'workflow["concurrency"]["group"] = machines_queue["group"].upcase'
# O deploy fora da fila do vigia: sem grupo ou cancelável.
expect_queue_failure "o job deploy precisa da fila do vigia" 'jobs["deploy"].delete("concurrency")'
expect_queue_failure "o job deploy precisa da fila do vigia" 'jobs["deploy"]["concurrency"] = machines_queue.merge("cancel-in-progress" => true)'
expect_queue_failure "o job deploy precisa vir depois do prepare" 'jobs["deploy"].delete("needs")'
# A espera longa de volta ao job que segura a fila.
expect_queue_failure "o build e a espera longa ficam no job prepare" 'jobs["prepare"]["steps"].reject! { |s| s["run"]&.include?("active_jobs") }'
# O preflight no job de fora: leria as Machines sem a fila do vigia.
expect_queue_failure "preflight, deploy e postflight ficam no job deploy" 'jobs["prepare"]["steps"] << jobs["deploy"]["steps"].find { |s| s["run"]&.include?("machines.sh pre") }; jobs["deploy"]["steps"].reject! { |s| s["run"]&.include?("machines.sh pre") }'
expect_queue_failure "o job deploy precisa reler as runs antes do preflight" 'jobs["deploy"]["steps"].reject! { |s| s["run"]&.include?("active_jobs") }'
expect_queue_failure "a releitura das runs tem de ser o mesmo passo da espera" 'jobs["deploy"]["steps"].map! { |s| s["run"]&.include?("active_jobs") ? s.merge("timeout-minutes" => 5) : s }'
expect_queue_failure "o job deploy só pode ter checkout, setup do flyctl" 'jobs["deploy"]["steps"] << { "run" => "sleep 600" }'
expect_queue_failure "o job deploy só pode ter checkout, setup do flyctl" 'jobs["deploy"]["steps"] << { "uses" => "actions/cache@v4" }'
# O prazo único da espera: sem ele, a releitura abriria outras 4 h na fila.
expect_queue_failure "o job deploy precisa receber o prazo do prepare" 'jobs["deploy"].delete("env")'
expect_queue_failure "o prepare precisa publicar o prazo da espera" 'jobs["prepare"].delete("outputs")'
expect_queue_failure "o prepare não pode receber WAIT_DEADLINE" 'jobs["prepare"]["env"] = { "WAIT_DEADLINE" => "1" }'

# Comportamento da espera: o `run` do passo é extraído do YAML e executado com
# curl, sleep e date falsos, na mesma invocação que o Actions usa para
# `shell: bash`. CURL_RESPONSES é uma linha por chamada: "FAIL" faz o curl sair
# 22 (a forma do 502 com -f); qualquer outra linha, inclusive vazia, sai no
# stdout com status 0. O relógio é um arquivo que `date +%s` lê: cada sleep o
# avança pelos segundos pedidos e cada leitura por 60 s, o pior caso do
# `--max-time`. Assim o prazo de 4 h vence sem esperar, e um prazo contado em
# voltas, e não em segundos de relógio, daria outro número de sleeps. O
# `timeout 120` só pega laço infinito: a run sem fim gasta uns 480 processos
# falsos, e com 20 s o caso reprovava a main em máquina carregada.
wait_script="$tmp_dir/wait-jobs.sh"
ruby -ryaml -e '
  workflow = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: true)
  step = workflow.fetch("jobs").fetch("prepare").fetch("steps").find { |s| s["run"]&.include?("active_jobs") }
  File.write(ARGV.fetch(1), step.fetch("run"))
' "$workflow" "$wait_script"

wait_bin="$tmp_dir/wait-bin"
mkdir -p "$wait_bin"
cat >"$wait_bin/curl" <<'EOF'
#!/usr/bin/env bash
count="$(cat "$WAIT_LOG.curl" 2>/dev/null || echo 0)"
echo "$((count + 1))" >"$WAIT_LOG.curl"
read -r clock <"$WAIT_LOG.clock"
echo "$((clock + 60))" >"$WAIT_LOG.clock"
line="$(sed -n "$((count + 1))p" "$CURL_RESPONSES")"
if [[ "$line" == "FAIL" ]]; then
  exit 22
fi
printf '%s' "$line"
EOF
cat >"$wait_bin/sleep" <<'EOF'
#!/usr/bin/env bash
echo "$1" >>"$WAIT_LOG.sleep"
read -r clock <"$WAIT_LOG.clock"
echo "$((clock + $1))" >"$WAIT_LOG.clock"
EOF
cat >"$wait_bin/date" <<'EOF'
#!/usr/bin/env bash
[[ "$*" == "+%s" ]] || { echo "date inesperado: $*" >&2; exit 64; }
read -r clock <"$WAIT_LOG.clock"
echo "$clock"
EOF
chmod +x "$wait_bin/curl" "$wait_bin/sleep" "$wait_bin/date"

# WAIT_ENV são as variáveis a mais de uma execução (o WAIT_DEADLINE do job
# deploy); vazio, o passo roda como no job prepare. O GITHUB_OUTPUT é sempre um
# arquivo novo, e nunca o do runner quando este teste roda no CI.
wait_env=()
run_wait_status() {
  printf '%s\n' "$@" >"$tmp_dir/curl-responses"
  rm -f "$tmp_dir/wait.curl" "$tmp_dir/wait.sleep"
  touch "$tmp_dir/wait.sleep"
  : >"$tmp_dir/wait.output"
  echo 1700000000 >"$tmp_dir/wait.clock"
  wait_output="$(env -u WAIT_DEADLINE "PATH=$wait_bin:$PATH" WAIT_LOG="$tmp_dir/wait" CURL_RESPONSES="$tmp_dir/curl-responses" \
    GITHUB_OUTPUT="$tmp_dir/wait.output" GITHUB_RUN_ATTEMPT=1 "${wait_env[@]}" \
    timeout 120 bash --noprofile --norc -eo pipefail "$wait_script" 2>&1)"
}

run_wait() {
  if ! run_wait_status "$@"; then
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
# Run que não termina: o prazo vence na 121ª leitura, depois de 120 sleeps, e o
# passo sai 0 para o deploy seguir. Sem a checagem do prazo, a leitura seguinte
# vem vazia e a espera sairia por "API sem resposta", com mais sleeps.
mapfile -t endless_run < <(yes '{"status":"ok","active_jobs":1}' | head -n 121)
run_wait "${endless_run[@]}"
assert_wait "Runs ainda em curso depois de 4 h; o deploy segue" "$(yes 60 | head -n 120 | paste -sd' ')"
# O prepare publica a tentativa e o prazo que calculou: o relógio falso mais 4 h.
[[ "$(cat "$tmp_dir/wait.output")" == "deadline=1:$((1700000000 + 4 * 60 * 60))" ]] || { echo "prazo publicado divergente: $(cat "$tmp_dir/wait.output")" >&2; exit 1; }

# No job deploy o prazo vem do prepare. Run que já o estourou lá não é esperada
# de novo dentro da fila do vigia: uma leitura, nenhum sleep.
wait_env=(WAIT_DEADLINE=1:1700000000)
run_wait "${endless_run[@]}"
assert_wait "Runs ainda em curso depois de 4 h; o deploy segue" ""
# Só o job deploy reexecutado, horas depois: o prazo recebido é o da tentativa
# 1 e esta é a 2. A run em curso ganha as 4 h inteiras, em vez de morrer na
# troca por um prazo vencido antes de a reexecução começar.
wait_env=(WAIT_DEADLINE=1:1700000000 GITHUB_RUN_ATTEMPT=2)
run_wait "${endless_run[@]}"
assert_wait "a espera recomeça com prazo novo" "$(yes 60 | head -n 120 | paste -sd' ')"
# Run iniciada entre os dois jobs, com 5 min de prazo restantes: espera só o
# resto (a 1ª leitura termina em +60 s; cada volta soma 120 s), e não outras 4 h.
wait_env=(WAIT_DEADLINE=1:$((1700000000 + 300)))
run_wait "${endless_run[@]}"
assert_wait "Runs ainda em curso depois de 4 h; o deploy segue" "60 60"
# Sem run, o prazo recebido não muda nada.
run_wait '{"status":"ok","active_jobs":0}'
assert_wait "Nenhuma run em curso." ""
# Prazo vazio ou ilegível (output do prepare perdido) reprova o passo em vez de
# abrir um prazo novo.
for bad_deadline in "" "amanhã" "1700000000" "1:17e9"; do
  wait_env=("WAIT_DEADLINE=$bad_deadline")
  expect_failure run_wait_status '{"status":"ok","active_jobs":0}'
  assert_wait "WAIT_DEADLINE sem o prazo" ""
  [[ ! -e "$tmp_dir/wait.curl" ]] || { echo "prazo \"$bad_deadline\" recusado só depois de ler o /health" >&2; exit 1; }
done
wait_env=()

# Contrato estático do fly.toml, conferido bloco a bloco sobre o TOML parseado
# (regras e porquês em fly-toml-contract.py, compartilhado com o contrato do
# frontend). Cada diretiva nomeia o bloco: `[[vm]]` tem de ser um só e ter só
# estas chaves.
expected_directives=(
  '[[vm]] size = "shared-cpu-1x"'
  '[[vm]] memory = "512mb"'
  '[http_service] auto_stop_machines = "off"'
  '[http_service] auto_start_machines = true'
  '[http_service] min_machines_running = 1'
)

check_fly_config() {
  python3 "$repo_root/.github/scripts/fly-toml-contract.py" "$1" "${expected_directives[@]}"
}

# Caso vermelho do contrato: reprova, e pela mensagem do contrato
# ("<arquivo>: ..."), para que um traceback do script não passe por recusa.
expect_contract_failure() {
  local output
  if output="$(check_fly_config "$1" 2>&1)"; then
    echo "o contrato deveria reprovar $1" >&2
    exit 1
  fi
  [[ $output == "$1: "* ]] || { printf 'o contrato reprovou %s sem a própria mensagem:\n%s\n' "$1" "$output" >&2; exit 1; }
}

check_fly_config "$fly_config"

# Casos vermelhos de cada diretiva. As regras que não dependem deste arquivo
# (tipo, [[vm]] a mais e seus aliases, scale-to-zero em outro bloco, TOML
# inválido, `#` dentro de string) estão em test-fly-toml-contract.sh. O awk
# acha a linha da diretiva normalizando-a (sem comentário e sem indentação;
# nenhuma diretiva esperada tem `#`).
mutated_config="$tmp_dir/fly.toml"
for entry in "${expected_directives[@]}"; do
  directive="${entry#* }"
  line="$(awk -v d="$directive" '{ t = $0; sub(/#.*/, "", t); gsub(/^[[:space:]]+|[[:space:]]+$/, "", t) } t == d { print NR; exit }' "$fly_config")"
  [[ -n $line ]] || { echo "$fly_config sem a linha $directive" >&2; exit 1; }
  # A diretiva que sobra só num comentário reprova (um grep de substring a
  # aprovaria)...
  sed "${line}s/^/# /" "$fly_config" >"$mutated_config"
  expect_contract_failure "$mutated_config"
  # ...e a que sai do bloco certo também: aqui ela vai para a raiz do arquivo,
  # onde o Fly não a lê, e a linha continua idêntica.
  { printf '%s\n' "$directive"; sed "${line}d" "$fly_config"; } >"$mutated_config"
  expect_contract_failure "$mutated_config"
done

echo "Contrato de Machines do backend validado."
