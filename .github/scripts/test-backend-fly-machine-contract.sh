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
printf '#!/usr/bin/env bash\nexit 0\n' >"$tmp_dir/bin/curl"
chmod +x "$tmp_dir/bin/curl"

machine() {
  local state="${1:-started}"
  local region="${2:-gru}"
  local cpu_kind="${3:-shared}"
  local cpus="${4:-1}"
  local memory_mb="${5:-512}"
  local autostop="${6:-\"suspend\"}"
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
run_checker post >/dev/null

for invalid_machine in \
  "$(machine stopped)" \
  "$(machine started iad)" \
  "$(machine started gru performance)" \
  "$(machine started gru shared 2)" \
  "$(machine started gru shared 1 1024)" \
  "$(machine started gru shared 1 512 false)" \
  "$(machine started gru shared 1 512 '"stop"')" \
  "$(machine started gru shared 1 512 '"suspend"' false)" \
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
  deploy = runs.index { |run| run.include?("flyctl deploy") && run.include?("--ha=false") }
  post = runs.index { |run| run.include?("check-backend-fly-machines.sh post") }
  abort("workflow sem ordem preflight -> deploy -> postflight") unless pre && deploy && post && pre < deploy && deploy < post
  abort("a espera pelas runs precisa vir antes do deploy") unless wait_jobs < deploy
' "$workflow"

grep -Fq 'size = "shared-cpu-1x"' "$fly_config"
grep -Fq 'memory = "512mb"' "$fly_config"
# Mesma comparação por linha inteira, sem comentários, do contrato do frontend:
# o arquivo cita em prosa formas que estas asserções rejeitam.
fly_directives="$(sed 's/#.*//; s/[[:space:]]*$//; s/^[[:space:]]*//' "$fly_config")"
for directive in 'auto_stop_machines = "suspend"' 'auto_start_machines = true' 'min_machines_running = 0'; do
  grep -Fxq "$directive" <<<"$fly_directives" || { echo "backend/fly.toml sem a diretiva esperada: $directive" >&2; exit 1; }
done

echo "Contrato de Machines do backend validado."
