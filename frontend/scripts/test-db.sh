#!/usr/bin/env bash

set -euo pipefail

frontend_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
supabase_cli="$frontend_root/node_modules/.bin/supabase"

if [[ ! -x "$supabase_cli" ]]; then
  echo "Supabase CLI is missing. Run npm install in frontend/." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker must be running to execute the database contract tests." >&2
  exit 1
fi

cd "$frontend_root"
"$supabase_cli" start >/dev/null
"$supabase_cli" db reset --local --no-seed

db_url=""
for _attempt in {1..30}; do
  db_url="$($supabase_cli status -o env 2>/dev/null | sed -n 's/^DB_URL="\(.*\)"$/\1/p' || true)"
  [[ -n "$db_url" ]] && break
  sleep 1
done
if [[ -z "$db_url" ]]; then
  echo "Supabase did not become ready after the local reset." >&2
  exit 1
fi

for test_file in "$frontend_root"/supabase/tests/*.test.sql; do
  echo "Running ${test_file#"$frontend_root"/}"
  docker run --rm --network host -i postgres:15 \
    psql "$db_url" -X -v ON_ERROR_STOP=1 < "$test_file"
done
