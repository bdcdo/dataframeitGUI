#!/usr/bin/env bash
#
# Medição pareada de um PR que sobe ferramenta de gate (regra e porquê em
# docs/CODE_QUALITY_TOOLING.md, "PR que sobe ferramenta de gate"): roda a
# versão antiga, a do merge-base, e a nova, a do HEAD, sobre a mesma árvore, e
# imprime o que cada uma acha.
#
# Uso, de dentro do worktree do PR:
#   bash frontend/scripts/measure-gate-bump.sh [pre-commit|uv] [base]
# Sem ecossistema, mede os dois. A base padrão é `git merge-base origin/main HEAD`.
#
#   pre-commit  check-merge-conflict e actionlint com a .pre-commit-config.yaml
#               de cada lado, e o gitleaks com o `rev` de cada lado.
#   uv          ruff (check e format --check) e mypy com o backend/uv.lock de
#               cada lado, em comandos só de leitura.
#
# O script existe para a receita não depender da definição dos hooks:
# - O hook do gitleaks roda `gitleaks git --pre-commit --staged` sem receber a
#   lista de arquivos, então `pre-commit run gitleaks --all-files` passa sem
#   escanear nada. Aqui o entry vira `gitleaks dir` sobre `git archive HEAD`
#   (só arquivos versionados: .venv, node_modules e .env.local ficam fora), e
#   um segredo canário gerado na hora é plantado na cópia: se ele não aparece
#   no relatório, a varredura não aconteceu e o script falha, em vez de medir
#   "0 achados" em silêncio.
# - O hook do ruff roda com --fix. Aqui o ruff roda pelo `uv run` com o lockfile
#   e a config ([tool.ruff], [tool.mypy]) de cada lado, sem passar pelo hook,
#   sem cache no worktree e sem reescrever arquivo.
#
# A medição é do HEAD: com mudança não commitada em arquivo versionado o script
# para, porque os hooks e o ruff/mypy leriam o worktree e o gitleaks o HEAD.
#
# O npm (react-doctor, fallow, typescript-eslint) não está aqui: a troca é o
# package.json e o package-lock.json com `npm ci`, descrita no doc.

set -euo pipefail

die() {
  echo "measure-gate-bump: $*" >&2
  exit 2
}

ecosystems=(pre-commit uv)
case "${1:-}" in
  pre-commit | uv) ecosystems=("$1"); shift ;;
esac
[[ $# -le 1 ]] || die "uso: measure-gate-bump.sh [pre-commit|uv] [base]"

repo="$(git rev-parse --show-toplevel)" || die "rode de dentro do repositório"
cd "$repo"
if [[ -n "${1:-}" ]]; then
  base="$(git rev-parse --verify "$1^{commit}")" || die "base inválida: $1"
else
  base="$(git merge-base origin/main HEAD)" || die "sem merge-base com origin/main; passe a base"
fi
head="$(git rev-parse HEAD)"
git diff --quiet HEAD || die "há mudança não commitada em arquivo versionado: commite ou guarde antes de medir o HEAD"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

sides=(antiga nova)
declare -A rev_of=([antiga]="$base" [nova]="$head")
summary=()

# Da config de um lado: os ids de hook (linha 1), o repo e o rev do hook
# gitleaks (linhas 2 e 3) e o rótulo da versão (linha 4): a tag do comentário
# `# frozen:` quando o rev é um SHA (#555), que o YAML descarta, ou o próprio
# rev. Falha alto se o gitleaks deixou de vir do repositório dele: a troca de
# entry abaixo depende disso.
read_hooks() {
  ruby -ryaml -e '
    text = File.read(ARGV.fetch(0))
    repos = YAML.safe_load(text).fetch("repos")
    gitleaks = repos.find { |r| r["hooks"]&.any? { |h| h["id"] == "gitleaks" } }
    abort("hook gitleaks ausente") unless gitleaks
    abort("hook gitleaks fora do repo gitleaks/gitleaks: #{gitleaks["repo"]}") unless gitleaks["repo"].to_s.end_with?("gitleaks/gitleaks")
    rev = gitleaks.fetch("rev").to_s
    frozen = text[/^\s*rev:\s*#{Regexp.escape(rev)}\s+#\s*frozen:\s*(\S+)/, 1]
    puts repos.flat_map { |r| (r["hooks"] || []).map { |h| h["id"] } }.join(" "), gitleaks["repo"], rev, frozen ? "#{frozen} (#{rev[0, 9]})" : rev
  ' "$1"
}

measure_pre_commit() {
  command -v pre-commit >/dev/null || die "pre-commit ausente (uv tool install pre-commit)"
  command -v jq >/dev/null || die "jq ausente"
  command -v ruby >/dev/null || die "ruby ausente (lê a .pre-commit-config.yaml)"

  local tree="$work/tree" canary
  mkdir -p "$tree"
  git archive HEAD | tar -x -C "$tree"
  # 36 caracteres hex aleatórios: a forma de um token do GitHub (regra
  # github-pat), gerada na hora para que nenhum segredo fique versionado.
  canary="ghp_$(od -An -N18 -tx1 /dev/urandom | tr -d ' \n')"
  printf 'token = "%s"\n' "$canary" >"$tree/gate-bump-canary.txt"

  local side config hook hooks status repo_url rev label report config_gitleaks counts
  for side in "${sides[@]}"; do
    config="$work/$side.pre-commit-config.yaml"
    git show "${rev_of[$side]}:.pre-commit-config.yaml" >"$config"
    { read -r hooks; read -r repo_url; read -r rev; read -r label; } < <(read_hooks "$config") || die "$side: hook gitleaks irreconhecível"

    for hook in check-merge-conflict actionlint; do
      echo "== $hook ($side, ${rev_of[$side]:0:9})"
      # Um hook ausente faz o `pre-commit run` sair com 1, o mesmo status de um
      # hook que achou problema.
      if [[ " $hooks " != *" $hook "* ]]; then
        echo "(ausente na .pre-commit-config.yaml deste lado)"
        summary+=("$hook ($side): ausente na config")
        continue
      fi
      status=0
      pre-commit run "$hook" --all-files --config "$config" || status=$?
      summary+=("$hook ($side): exit $status")
    done

    report="$work/$side.gitleaks.json"
    config_gitleaks="$work/$side.gitleaks-config.yaml"
    cat >"$config_gitleaks" <<EOF
repos:
  - repo: $repo_url
    rev: $rev
    hooks:
      - id: gitleaks
        entry: gitleaks dir --no-banner --redact --exit-code 0 --config $tree/.gitleaks.toml --report-format json --report-path $report $tree
EOF
    echo "== gitleaks $label ($side)"
    # --exit-code 0: achado não é erro aqui. Exit != 0 é a ferramenta que não
    # rodou, e isso não vira contagem.
    pre-commit run gitleaks --all-files --verbose --config "$config_gitleaks" \
      || die "gitleaks $label ($side) não rodou"
    [[ -s "$report" ]] || die "gitleaks $label ($side) não gravou o relatório: nada foi escaneado"
    # Canários achados e o resto dos achados.
    mapfile -t counts < <(jq 'map(.File | endswith("/gate-bump-canary.txt")) | (map(select(.)) | length), (map(select(not)) | length)' "$report")
    [[ "${counts[0]}" -ge 1 ]] \
      || die "gitleaks $label ($side) não achou o canário plantado: a varredura não leu a árvore"
    summary+=("gitleaks $label ($side): ${counts[1]} achado(s)")
  done
}

# Roda no backend/ uma ferramenta de um projeto temporário: projeto, rótulo do
# resumo e comando.
run_backend_tool() {
  local project="$1" label="$2" status=0
  shift 2
  echo "== $label"
  (cd backend && uv run --project "$project" --locked "$@") || status=$?
  summary+=("$label: exit $status")
}

measure_uv() {
  command -v uv >/dev/null || die "uv ausente"
  local side project file config
  for side in "${sides[@]}"; do
    project="$work/$side.backend"
    config="$project/pyproject.toml"
    mkdir -p "$project"
    for file in pyproject.toml uv.lock .python-version; do
      git show "${rev_of[$side]}:backend/$file" >"$project/$file"
    done
    uv sync --project "$project" --locked || die "uv sync ($side) falhou"
    echo "== $side: $(uv run --project "$project" --locked ruff --version), $(uv run --project "$project" --locked mypy --version)"
    # A config vem do lado medido: no backend/ o ruff e o mypy leriam a do
    # worktree, e uma regra nova na config reprovaria a versão antiga.
    run_backend_tool "$project" "ruff check --statistics ($side)" ruff check --no-cache --config "$config" --statistics .
    run_backend_tool "$project" "ruff format --check ($side)" ruff format --no-cache --config "$config" --check .
    run_backend_tool "$project" "mypy ($side)" mypy --config-file "$config" --cache-dir "$project/.mypy_cache" .
  done
}

for ecosystem in "${ecosystems[@]}"; do
  "measure_${ecosystem//-/_}"
done

echo "────────────────────────────────────────"
echo "base (antiga) ${base:0:9} × HEAD (nova) ${head:0:9}"
printf '%s\n' "${summary[@]}"
