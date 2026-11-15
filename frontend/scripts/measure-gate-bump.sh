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

# O hook existe na config deste lado? Um hook ausente faz o `pre-commit run`
# sair com 1, o mesmo status de um hook que achou problema.
has_hook() {
  ruby -ryaml -e '
    config = YAML.safe_load(File.read(ARGV.fetch(0)))
    exit(config.fetch("repos").any? { |r| r["hooks"]&.any? { |h| h["id"] == ARGV.fetch(1) } })
  ' "$1" "$2"
}

# Rev e repo do hook gitleaks na config de um lado. Falha alto se o hook deixou
# de vir do repositório do gitleaks: a troca de entry abaixo depende disso.
gitleaks_hook() {
  ruby -ryaml -e '
    config = YAML.safe_load(File.read(ARGV.fetch(0)))
    repo = config.fetch("repos").find { |r| r["hooks"]&.any? { |h| h["id"] == "gitleaks" } }
    abort("hook gitleaks ausente") unless repo
    abort("hook gitleaks fora do repo gitleaks/gitleaks: #{repo["repo"]}") unless repo["repo"].to_s.end_with?("gitleaks/gitleaks")
    puts repo["repo"], repo.fetch("rev")
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

  local side config hook status repo_url rev report config_gitleaks total canaries
  for side in "${sides[@]}"; do
    config="$work/$side.pre-commit-config.yaml"
    git show "${rev_of[$side]}:.pre-commit-config.yaml" >"$config"

    for hook in check-merge-conflict actionlint; do
      echo "== $hook ($side, ${rev_of[$side]:0:9})"
      if ! has_hook "$config" "$hook"; then
        echo "(ausente na .pre-commit-config.yaml deste lado)"
        summary+=("$hook ($side): ausente na config")
        continue
      fi
      status=0
      pre-commit run "$hook" --all-files --config "$config" || status=$?
      summary+=("$hook ($side): exit $status")
    done

    { read -r repo_url; read -r rev; } < <(gitleaks_hook "$config") || die "$side: hook gitleaks irreconhecível"
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
    echo "== gitleaks $rev ($side)"
    # --exit-code 0: achado não é erro aqui. Exit != 0 é a ferramenta que não
    # rodou, e isso não vira contagem.
    pre-commit run gitleaks --all-files --verbose --config "$config_gitleaks" \
      || die "gitleaks $rev ($side) não rodou"
    [[ -s "$report" ]] || die "gitleaks $rev ($side) não gravou o relatório: nada foi escaneado"
    canaries="$(jq '[.[] | select(.File | endswith("/gate-bump-canary.txt"))] | length' "$report")"
    total="$(jq length "$report")"
    [[ "$canaries" -ge 1 ]] \
      || die "gitleaks $rev ($side) não achou o canário plantado: a varredura não leu a árvore"
    summary+=("gitleaks $rev ($side): $((total - canaries)) achado(s)")
  done
}

# Roda no backend/ uma ferramenta do projeto temporário do lado: rótulo e
# comando.
run_backend_tool() {
  local label="$1" status=0
  shift
  echo "== $label ($side, $(cd backend && uv run --project "$project" --locked "$1" --version))"
  (cd backend && uv run --project "$project" --locked "$@") || status=$?
  summary+=("$label ($side): exit $status")
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
    # A config vem do lado medido: no backend/ o ruff e o mypy leriam a do
    # worktree, e uma regra nova na config reprovaria a versão antiga.
    run_backend_tool "ruff check --statistics" ruff check --no-cache --config "$config" --statistics .
    run_backend_tool "ruff format --check" ruff format --no-cache --config "$config" --check .
    run_backend_tool "mypy" mypy --config-file "$config" --cache-dir "$project/.mypy_cache" .
  done
}

for ecosystem in "${ecosystems[@]}"; do
  "measure_${ecosystem//-/_}"
done

echo "────────────────────────────────────────"
echo "base (antiga) ${base:0:9} × HEAD (nova) ${head:0:9}"
printf '%s\n' "${summary[@]}"
