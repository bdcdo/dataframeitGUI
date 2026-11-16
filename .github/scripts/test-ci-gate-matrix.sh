#!/usr/bin/env bash
# Contrato da matriz de gates do CI (#649): o ci-gate-matrix.sh sobre os
# arquivos de verdade e sobre fixtures, e a forma do ci.yml de que o check
# obrigatório depende.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
matrix_script="$repo_root/.github/scripts/ci-gate-matrix.sh"
real_config="$repo_root/.pre-commit-config.yaml"
workflow="$repo_root/.github/workflows/ci.yml"
database_workflow="$repo_root/.github/workflows/database-tests.yml"
secret_scan_workflow="$repo_root/.github/workflows/secret-scan.yml"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
config="$tmp_dir/config.yaml"
exempt="$tmp_dir/exempt.json"
shards="$tmp_dir/shards.json"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

# Nomes das células, um por linha.
cells() {
  bash "$matrix_script" "$@" | jq -r '.include[].name'
}

# Reprova, e pela mensagem do contrato, para que um erro do ruby não passe por
# recusa.
expect_rejected() {
  local output
  if output="$(bash "$matrix_script" "$config" "$exempt" "$shards" 2>&1)"; then
    fail "a matriz deveria reprovar ($1), e saiu: $output"
  fi
  grep -qF -- "$2" <<<"$output" || fail "reprovou ($1) sem a mensagem \"$2\": $output"
}

reset_fixture() {
  cat >"$config" <<'EOF'
default_stages: [pre-commit]
repos:
  - repo: https://example.invalid/remoto
    rev: 0000000000000000000000000000000000000000
    hooks:
      - id: leve-remoto
  - repo: local
    hooks:
      - id: leve
        entry: "true"
        language: system
      - id: pesado
        entry: "true"
        language: system
        stages: [pre-push]
      - id: fora-do-servidor
        entry: "true"
        language: system
        stages: [pre-push]
      - id: informativo
        entry: "true"
        language: system
        stages: [post-checkout]
EOF
  echo '{"fora-do-servidor": "precisa de segredo"}' >"$exempt"
  echo '{}' >"$shards"
}

# --- os arquivos de verdade ---

real="$(cells)"
[[ -n "$real" ]] || fail "a matriz de verdade saiu vazia"
for exempted in $(jq -r 'keys[]' "$repo_root/.github/ci-exempt-gates.json"); do
  grep -qx -- "$exempted" <<<"$real" && fail "hook isento virou célula: $exempted"
done

# O discriminante da #649: hook novo de pre-push no .pre-commit-config.yaml
# vira célula sozinho, sem tocar no ci.yml nem em lista nenhuma.
cp "$real_config" "$config"
cat >>"$config" <<'EOF'
  - repo: local
    hooks:
      - id: hook-de-mentira
        entry: "true"
        language: system
        stages: [pre-push]
EOF
with_fake="$(cells "$config")"
grep -qx 'hook-de-mentira' <<<"$with_fake" || fail "hook novo de pre-push não virou célula"
[[ "$(wc -l <<<"$with_fake")" -eq $(($(wc -l <<<"$real") + 1)) ]] || fail "o hook novo mudou outras células"

# --- fixture ---

reset_fixture
[[ "$(cells "$config" "$exempt" "$shards")" == "pesado" ]] ||
  fail "só o hook de pre-push fora das exceções deveria ser célula"

echo '{"pesado": 3}' >"$shards"
[[ "$(cells "$config" "$exempt" "$shards" | paste -sd, -)" == "pesado (1/3),pesado (2/3),pesado (3/3)" ]] ||
  fail "shard declarado não virou uma célula por fatia"
[[ "$(bash "$matrix_script" "$config" "$exempt" "$shards" | jq -c '[.include[] | [.id, .shard]]')" == '[["pesado","1/3"],["pesado","2/3"],["pesado","3/3"]]' ]] ||
  fail "as fatias não carregam o id do hook e o shard"

# Sem `default_stages`, hook sem `stages` roda em todo estágio, pre-push
# inclusive.
reset_fixture
sed -i '/^default_stages:/d' "$config"
[[ "$(cells "$config" "$exempt" "$shards" | paste -sd, -)" == "leve-remoto,leve,pesado" ]] ||
  fail "sem default_stages, hook sem stages deveria ser célula"

reset_fixture
echo '{"fora-do-servidor": "precisa de segredo", "hook-que-sumiu": "motivo"}' >"$exempt"
expect_rejected "exceção de hook inexistente" 'exceção órfã'

reset_fixture
echo '{"fora-do-servidor": "precisa de segredo", "informativo": "motivo"}' >"$exempt"
expect_rejected "exceção de hook de post-checkout" 'exceção órfã'

# Exceção de hook de pre-commit vale (o job `lint` a lê em SKIP) e não mexe
# nas células.
reset_fixture
echo '{"fora-do-servidor": "precisa de segredo", "leve": "motivo"}' >"$exempt"
[[ "$(cells "$config" "$exempt" "$shards")" == "pesado" ]] ||
  fail "exceção de hook de pre-commit deveria ser aceita sem mudar as células"

for empty_reason in '""' '"   "' 'null' 'true'; do
  reset_fixture
  echo "{\"fora-do-servidor\": $empty_reason}" >"$exempt"
  expect_rejected "exceção com motivo $empty_reason" 'sem motivo'
done

reset_fixture
echo '{"fora-do-servidor": "motivo", "pesado": "motivo"}' >"$exempt"
expect_rejected "todos os hooks isentos" 'a matriz ficaria vazia'

reset_fixture
echo '{"fora-do-servidor": 2}' >"$shards"
expect_rejected "shard de hook isento" 'shard órfão'

for bad_count in 1 '"2"'; do
  reset_fixture
  echo "{\"pesado\": $bad_count}" >"$shards"
  expect_rejected "shard com contagem $bad_count" 'inteiro >= 2'
done

# --- a forma do ci.yml ---

# GitHub expressions are compared as literal YAML strings inside Ruby.
# shellcheck disable=SC2016
ruby -ryaml -e '
  workflow = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: true)
  trigger = workflow["on"] || workflow[true]

  # Workflow com filtro que não dispara deixa o check obrigatório em
  # "Expected" para sempre, e o PR trava sem nada vermelho.
  abort("ci.yml precisa disparar em todo pull_request") unless trigger.key?("pull_request")
  trigger.each do |event, filters|
    next unless filters.is_a?(Hash)
    filtered = filters.keys & %w[paths paths-ignore]
    abort("ci.yml não pode filtrar #{event} por #{filtered.join(", ")}: o check obrigatório ficaria Expected") unless filtered.empty?
  end
  pr_filters = (trigger["pull_request"] || {}).keys & %w[branches branches-ignore types]
  abort("ci.yml não pode restringir pull_request por #{pr_filters.join(", ")}") unless pr_filters.empty?

  jobs = workflow.fetch("jobs")
  required = jobs.fetch("ci-required")
  abort("ci-required precisa de `if: always()`: sem ele vira skipped, que o GitHub aceita") unless required["if"] == "always()"
  missing = jobs.keys - ["ci-required"] - Array(required["needs"])
  abort("ci-required não espera por: #{missing.join(", ")}") unless missing.empty?
  check = required.fetch("steps").map { |step| step["run"].to_s }.join("\n")
  abort("ci-required precisa exigir success de todos os jobs") unless check.include?(%q{all(.[]; .result == "success")})

  # O estágio pre-commit inteiro, menos as exceções do mesmo arquivo: hook
  # leve novo entra sozinho, sem lista aqui.
  light = jobs.fetch("lint").fetch("steps").map { |step| step["run"].to_s }.find { |text| text.include?("--hook-stage pre-commit --all-files") } or abort("o lint não roda os hooks de pre-commit com --all-files")
  abort("o lint precisa tirar o SKIP de ci-exempt-gates.json") unless light =~ /SKIP="\$\(jq -r .keys \| join\(","\). \.github\/ci-exempt-gates\.json\)"/

  # As exceções db-tests, llm-runs-contract e gitleaks apontam para estes
  # jobs. Workflow chamado que deixe de aceitar a chamada, ou peça permissão
  # que o job não concede, derruba o ci.yml inteiro na largada: nenhum job roda
  # e o check obrigatório fica "Expected".
  called_runs = { "database" => ARGV.fetch(1), "secret-scan" => ARGV.fetch(2) }.to_h do |job, path|
    file = File.basename(path)
    abort("o job #{job} precisa chamar o #{file}") unless jobs.dig(job, "uses") == "./.github/workflows/#{file}"
    called = YAML.safe_load(File.read(path), aliases: true)
    called_trigger = called["on"] || called[true]
    abort("#{file} precisa de workflow_call: é o ci.yml que o chama") unless called_trigger.key?("workflow_call")
    own = called_trigger.keys & %w[pull_request push]
    abort("#{file} não pode disparar sozinho em #{own.join(", ")}: rodaria duas vezes") unless own.empty?
    abort("#{file} pede permissão diferente da que o job #{job} concede") unless called["permissions"] == jobs.dig(job, "permissions")
    # Grupo próprio cancelaria, na main, o job do merge anterior, e o
    # ci-required daquele commit ficaria vermelho.
    abort("#{file} não pode ter concurrency próprio: vale o do ci.yml") if called.key?("concurrency") || called.fetch("jobs").values.any? { |called_job| called_job.key?("concurrency") }
    [job, called.fetch("jobs").values.flat_map { |called_job| called_job.fetch("steps") }]
  end
  abort("database-tests.yml precisa rodar o runner (npm run test:db)") unless called_runs.fetch("database").any? { |step| step["run"] == "npm run test:db" }
  abort("secret-scan.yml precisa rodar a gitleaks-action") unless called_runs.fetch("secret-scan").any? { |step| step["uses"].to_s.start_with?("gitleaks/gitleaks-action@") }

  gate = jobs.fetch("gate")
  abort("a matriz do gate precisa vir do job discover") unless gate.dig("strategy", "matrix") == "${{ fromJSON(needs.discover.outputs.matrix) }}"
  abort("uma célula vermelha não pode cancelar as outras") unless gate.dig("strategy", "fail-fast") == false
  run = gate.fetch("steps").find { |step| step["run"].to_s.include?("pre-commit") } or abort("o gate não roda o pre-commit")
  env = run.fetch("env")
  abort("o gate precisa passar o id e o shard da célula ao hook") unless env["HOOK_ID"] == "${{ matrix.id }}" && env["GATE_SHARD"] == "${{ matrix.shard }}"
  abort("o gate precisa de GATE_FAIL_OPEN=0: no servidor, gate que não rodou não passa") unless env["GATE_FAIL_OPEN"] == "0"
' "$workflow" "$database_workflow" "$secret_scan_workflow"

echo "contrato da matriz de gates: ok"
