#!/usr/bin/env bash
#
# Roda os testes de integração do backend (`pytest -m integration`) contra o
# Supabase local, com a URL e a service key que o `supabase status` informa.
#
# Cobre os contratos do backend com o banco (#674): llm_runner (llm_runs,
# publicação de respostas, pydantic_hash), limitador de LLM, autorização e
# outbox da auto-revisão. O porquê de cada um está no docstring do arquivo em
# backend/tests/integration/.
#
# Fail-closed como as suítes SQL: sem `uv`, ou sem API no `supabase status`,
# sai != 0 em vez de pular.

set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v uv >/dev/null 2>&1; then
  echo "uv ausente — instale o astral uv para rodar os testes do backend" >&2
  exit 2
fi

# As variáveis já definidas prevalecem: é como apontar para outro stack local
# (o teste recusa URL que não seja de loopback).
url="${INTEGRATION_SUPABASE_URL:-}"
key="${INTEGRATION_SUPABASE_SERVICE_KEY:-}"
if [[ -z "${url}" || -z "${key}" ]]; then
  status_env="$(npx supabase status -o env)"
  url="$(sed -n 's/^API_URL="\(.*\)"$/\1/p' <<<"${status_env}")"
  key="$(sed -n 's/^SERVICE_ROLE_KEY="\(.*\)"$/\1/p' <<<"${status_env}")"
fi
if [[ -z "${url}" || -z "${key}" ]]; then
  echo "supabase status sem API_URL/SERVICE_ROLE_KEY — rode 'npx supabase start' antes." >&2
  exit 2
fi

cd ../backend
INTEGRATION_SUPABASE_URL="${url}" INTEGRATION_SUPABASE_SERVICE_KEY="${key}" \
  exec uv run pytest -m integration -q tests/integration
