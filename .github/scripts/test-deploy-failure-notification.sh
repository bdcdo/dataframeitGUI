#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
notifier_workflow="$repo_root/.github/workflows/notify-deploy-failure.yml"
caller_workflows=(
  "$repo_root/.github/workflows/frontend-fly-deploy.yml"
  "$repo_root/.github/workflows/fly-deploy.yml"
)
workflows=("$notifier_workflow" "${caller_workflows[@]}")

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
notifier="$tmp_dir/notify-deploy-failure.sh"

ruby -ryaml -e '
  workflow = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: true)
  step = workflow.fetch("jobs").fetch("notify").fetch("steps").fetch(0)
  abort("step canônico do notifier sem bloco run") unless step["run"].is_a?(String)
  print step.fetch("run")
' "$notifier_workflow" >"$notifier"

bash -n "$notifier" "$0"
ruby -ryaml -e 'ARGV.each { |path| abort("YAML inválido: #{path}") unless YAML.parse_file(path) }' "${workflows[@]}"

# GitHub expressions are compared as literal YAML strings inside Ruby.
# shellcheck disable=SC2016
ruby -ryaml -e '
  reusable_path = ARGV.fetch(0)
  reusable = YAML.safe_load(File.read(reusable_path), aliases: true)
  reusable_trigger = reusable["on"] || reusable[true]
  abort("notifier não expõe workflow_call") unless reusable_trigger&.key?("workflow_call")
  expected_inputs = %w[deploy_actor deploy_app deploy_result deploy_run_url deploy_sha deploy_workflow]
  actual_inputs = reusable_trigger.fetch("workflow_call").fetch("inputs").keys.sort
  abort("inputs do notifier divergiram") unless actual_inputs == expected_inputs

  notify = reusable.fetch("jobs").fetch("notify")
  abort("notifier precisa somente de issues: write") unless notify.fetch("permissions") == { "issues" => "write" }
  abort("notifier sem condição de failure") unless notify.fetch("if").include?("inputs.deploy_result == \u0027failure\u0027")
  abort("notifier reutilizável não pode fazer checkout") if notify.fetch("steps").any? { |step| step.fetch("uses", "").include?("checkout") }
  expected_env = {
    "GH_TOKEN" => "${{ github.token }}",
    "GITHUB_REPOSITORY" => "${{ github.repository }}",
    "DEPLOY_RESULT" => "${{ inputs.deploy_result }}",
    "DEPLOY_WORKFLOW" => "${{ inputs.deploy_workflow }}",
    "DEPLOY_APP" => "${{ inputs.deploy_app }}",
    "DEPLOY_SHA" => "${{ inputs.deploy_sha }}",
    "DEPLOY_ACTOR" => "${{ inputs.deploy_actor }}",
    "DEPLOY_RUN_URL" => "${{ inputs.deploy_run_url }}",
    "DEPLOY_OWNER" => "${{ github.repository_owner }}",
  }
  abort("ambiente do notifier divergiu") unless notify.fetch("env") == expected_env
  run = notify.fetch("steps").fetch(0).fetch("run")
  abort("notifier precisa enumerar issues pela API") unless run.include?("gh api --paginate")
  abort("notifier não pode depender do índice de busca") if run.include?("--search")

  ARGV.drop(1).each do |path|
    workflow = YAML.safe_load(File.read(path), aliases: true)
    concurrency = workflow.fetch("concurrency")
    abort("caller precisa serializar deploys: #{path}") unless concurrency["cancel-in-progress"] == false
    caller = workflow.fetch("jobs").fetch("notify-failure")
    abort("caller sem dependência do deploy: #{path}") unless caller["needs"] == "deploy"
    abort("caller sem condição de failure: #{path}") unless caller.fetch("if").include?("needs.deploy.result == \u0027failure\u0027")
    abort("caller não usa workflow canônico: #{path}") unless caller["uses"] == "./.github/workflows/notify-deploy-failure.yml"
    abort("caller precisa somente de issues: write: #{path}") unless caller.fetch("permissions") == { "issues" => "write" }
    abort("caller reutilizável não pode declarar steps/runs-on: #{path}") if caller.key?("steps") || caller.key?("runs-on")

    caller_inputs = caller.fetch("with")
    abort("inputs do caller divergiram: #{path}") unless caller_inputs.keys.sort == expected_inputs
    expected_app = path.include?("frontend-") ? "gui-analise-sistematica-frontend" : "gui-analise-sistematica-api"
    abort("aplicação incorreta: #{path}") unless caller_inputs.fetch("deploy_app") == expected_app
    abort("resultado não vem do deploy: #{path}") unless caller_inputs.fetch("deploy_result").include?("needs.deploy.result")

    trigger = workflow["on"] || workflow[true]
    paths = trigger.fetch("push").fetch("paths")
    abort("mudança no notifier não pode disparar deploy: #{path}") if paths.any? { |entry| entry.include?("notify-deploy-failure") }
  end
' "$notifier_workflow" "${caller_workflows[@]}"

mkdir -p "$tmp_dir/bin"
cat >"$tmp_dir/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

count=0
if [[ -f "$CAPTURE_DIR/call-count" ]]; then
  read -r count <"$CAPTURE_DIR/call-count"
fi
((count += 1))
printf '%s\n' "$count" >"$CAPTURE_DIR/call-count"

call_dir="$CAPTURE_DIR/call-$count"
mkdir -p "$call_dir"

normalized=()
body_file_next=0
for arg in "$@"; do
  if [[ "$body_file_next" == "1" ]]; then
    cp "$arg" "$call_dir/body"
    normalized+=("<BODY_FILE>")
    body_file_next=0
    continue
  fi

  normalized+=("$arg")
  if [[ "$arg" == "--body-file" ]]; then
    body_file_next=1
  fi
done
printf '%s\n' "${normalized[@]}" >"$call_dir/args"

if [[ "${1:-}" == "api" ]]; then
  printf '%s' "${GH_LIST_OUTPUT:-}"
fi
EOF
chmod +x "$tmp_dir/bin/gh"

reset_capture() {
  rm -rf "$tmp_dir"/call-* "$tmp_dir/call-count"
}

assert_args() {
  local call_number="$1"
  shift

  local -a actual expected
  mapfile -t actual <"$tmp_dir/call-$call_number/args"
  expected=("$@")

  if [[ "${#actual[@]}" -ne "${#expected[@]}" ]]; then
    echo "Chamada $call_number recebeu ${#actual[@]} args; esperados ${#expected[@]}" >&2
    return 1
  fi

  local index
  for index in "${!expected[@]}"; do
    if [[ "${actual[$index]}" != "${expected[$index]}" ]]; then
      echo "Chamada $call_number, arg $index: '${actual[$index]}' != '${expected[$index]}'" >&2
      return 1
    fi
  done
}

common_env=(
  "PATH=$tmp_dir/bin:$PATH"
  "CAPTURE_DIR=$tmp_dir"
  "GH_TOKEN=test-token"
  "GITHUB_REPOSITORY=bdcdo/dataframeitGUI"
  "DEPLOY_WORKFLOW=Deploy frontend (Fly.io)"
  "DEPLOY_APP=gui-analise-sistematica-frontend"
  "DEPLOY_SHA=0123456789abcdef"
  "DEPLOY_ACTOR=reviewer"
  "DEPLOY_RUN_URL=https://github.com/bdcdo/dataframeitGUI/actions/runs/123"
  "DEPLOY_OWNER=bdcdo"
)

incident_title='[Deploy quebrado] gui-analise-sistematica-frontend'
api_endpoint='repos/bdcdo/dataframeitGUI/issues?state=open&per_page=100'
api_filter='.[] | select(.pull_request == null) | [.number, .title] | @tsv'

# Sem incidente aberto: enumera diretamente as issues e cria uma atribuída.
reset_capture
env "${common_env[@]}" GH_LIST_OUTPUT= DEPLOY_RESULT=failure bash "$notifier" >/dev/null
assert_args 1 \
  api \
  --paginate \
  "$api_endpoint" \
  --jq "$api_filter"
assert_args 2 \
  issue create \
  --repo bdcdo/dataframeitGUI \
  --assignee bdcdo \
  --title "$incident_title" \
  --body-file '<BODY_FILE>'
grep -Fq "Deploy frontend (Fly.io)" "$tmp_dir/call-2/body"
grep -Fq 'gui-analise-sistematica-frontend' "$tmp_dir/call-2/body"
grep -Fq '0123456789abcdef' "$tmp_dir/call-2/body"
grep -Fq '@reviewer' "$tmp_dir/call-2/body"
grep -Fq 'https://github.com/bdcdo/dataframeitGUI/actions/runs/123' "$tmp_dir/call-2/body"
grep -Fq 'Feche esta issue somente depois' "$tmp_dir/call-2/body"
test ! -e "$tmp_dir/call-3"

# Incidente exato já aberto: ignora título parecido e comenta no existente.
reset_capture
open_issues=$'730\t[Deploy quebrado] gui-analise-sistematica-frontend antigo\n731\t[Deploy quebrado] gui-analise-sistematica-frontend\n'
env "${common_env[@]}" "GH_LIST_OUTPUT=$open_issues" DEPLOY_RESULT=failure bash "$notifier" >/dev/null
assert_args 1 \
  api \
  --paginate \
  "$api_endpoint" \
  --jq "$api_filter"
assert_args 2 \
  issue comment 731 \
  --repo bdcdo/dataframeitGUI \
  --body-file '<BODY_FILE>'
grep -Fq '## Falha em 0123456' "$tmp_dir/call-2/body"
grep -Fq 'https://github.com/bdcdo/dataframeitGUI/actions/runs/123' "$tmp_dir/call-2/body"
test ! -e "$tmp_dir/call-3"

# Deploy verde não consulta nem muta issues.
reset_capture
env "${common_env[@]}" DEPLOY_RESULT=success bash "$notifier" >/dev/null
test ! -e "$tmp_dir/call-count"

# Ambiente inválido falha antes de consultar ou mutar issues.
reset_capture
if env "${common_env[@]}" DEPLOY_RESULT=failure DEPLOY_RUN_URL= bash "$notifier" >/dev/null 2>&1; then
  echo "Notifier aceitou variável obrigatória vazia" >&2
  exit 1
fi
test ! -e "$tmp_dir/call-count"

echo "Validação da notificação de deploy passou."
