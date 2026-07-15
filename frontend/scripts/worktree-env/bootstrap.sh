#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd -- "$script_dir/../../.." && pwd -P)"
target_dir="$repo_root/frontend"
env_files=(.env.local .env.e2e)

usage() {
  printf 'Uso: %s --source <diretorio-frontend-fonte>\n' "$0" >&2
}

fail() {
  printf 'Erro: %s\n' "$1" >&2
  exit 1
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

required_names() {
  sed -nE 's/^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=.*$/\1/p' "$1"
}

has_nonempty_value() {
  local env_file="$1"
  local expected_name="$2"
  local line value first last

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="$(trim "${line%$'\r'}")"
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" =~ ^(export[[:space:]]+)?${expected_name}[[:space:]]*= ]] || continue

    value="$(trim "${line#*=}")"
    if (( ${#value} >= 2 )); then
      first="${value:0:1}"
      last="${value: -1}"
      if [[ ( "$first" == '"' && "$last" == '"' ) || ( "$first" == "'" && "$last" == "'" ) ]]; then
        value="$(trim "${value:1:${#value}-2}")"
      fi
    fi

    [[ -n "$value" ]] && return 0
  done <"$env_file"

  return 1
}

if [[ $# -ne 2 || "$1" != "--source" || -z "$2" ]]; then
  usage
  exit 2
fi

source_argument="$2"
if ! source_dir="$(cd -- "$source_argument" 2>/dev/null && pwd -P)"; then
  fail "fonte inexistente: $source_argument"
fi

for filename in "${env_files[@]}"; do
  [[ -f "$source_dir/$filename" ]] || fail "fonte sem $filename"
  destination="$target_dir/$filename"
  if [[ -e "$destination" || -L "$destination" ]]; then
    fail "destino já existe: frontend/$filename"
  fi
done

missing=()
for filename in "${env_files[@]}"; do
  example_file="$target_dir/$filename.example"
  [[ -f "$example_file" ]] || fail "contrato inexistente: frontend/$filename.example"

  while IFS= read -r name; do
    if ! has_nonempty_value "$source_dir/$filename" "$name"; then
      missing+=("$name")
    fi
  done < <(required_names "$example_file")
done

if (( ${#missing[@]} > 0 )); then
  missing_list="$(IFS=,; printf '%s' "${missing[*]}")"
  fail "variáveis obrigatórias ausentes: $missing_list"
fi

created=()
rollback() {
  local destination
  for destination in "${created[@]}"; do
    rm -f -- "$destination"
  done
}

rollback_on_error() {
  local status=$?
  rollback
  exit "$status"
}
trap rollback_on_error ERR

for filename in "${env_files[@]}"; do
  destination="$target_dir/$filename"
  ln -s -- "$source_dir/$filename" "$destination"
  created+=("$destination")
done

trap - ERR
printf 'Worktree provisionada: frontend/.env.local e frontend/.env.e2e são symlinks para a fonte explícita.\n'
