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
#   de cada lado, sem passar pelo hook, e nunca reescreve arquivo.
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

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

sides=(antiga nova)
declare -A rev_of=([antiga]="$base" [nova]="$head")
summary=()

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

  local tree="$work/tree" canary
  mkdir -p "$tree"
  git archive HEAD | tar -x -C "$tree"
  # 36 caracteres hex aleatórios: a forma de um token do GitHub (regra
  # github-pat), gerada na hora para que nenhum segredo fique versionado.
  canary="ghp_$(od -An -N18 -tx1 /dev/urandom | tr -d ' \n')"
  printf 'token = "%s"\n' "$canary" >"$tree/gate-bump-canary.txt"

  local side config hook status output repo_url rev report config_gitleaks total canaries
  for side in "${sides[@]}"; do
    config="$work/$side.pre-commit-config.yaml"
    git show "${rev_of[$side]}:.pre-commit-config.yaml" >"$config"

    for hook in check-merge-conflict actionlint; do
      echo "== $hook ($side, ${rev_of[$side]:0:9})"
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

measure_uv() {
  command -v uv >/dev/null || die "uv ausente"
  local side project status tool
  for side in "${sides[@]}"; do
    project="$work/$side.backend"
    mkdir -p "$project"
    for file in pyproject.toml uv.lock .python-version; do
      git show "${rev_of[$side]}:backend/$file" >"$project/$file"
    done
    uv sync --project "$project" --locked || die "uv sync ($side) falhou"
    for tool in "ruff check --statistics ." "ruff format --check ." "mypy ."; do
      echo "== $tool ($side, $(cd backend && uv run --project "$project" --locked ${tool%% *} --version))"
      status=0
      # shellcheck disable=SC2086 # o comando é a lista de palavras acima
      (cd backend && uv run --project "$project" --locked $tool) || status=$?
      summary+=("${tool% .} ($side): exit $status")
    done
  done
}

for ecosystem in "${ecosystems[@]}"; do
  "measure_${ecosystem//-/_}"
done

echo "────────────────────────────────────────"
echo "base (antiga) ${base:0:9} × HEAD (nova) ${head:0:9}"
printf '%s\n' "${summary[@]}"
