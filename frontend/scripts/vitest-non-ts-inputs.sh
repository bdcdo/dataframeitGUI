#!/usr/bin/env bash
#
# Hook de pre-push `vitest-non-ts-inputs`: roda as suítes do vitest que leem
# arquivos que não são TS e mudam fora do frontend/src — migrations e suítes
# SQL do Supabase, o backend e o .pre-commit-config.yaml. O hook do vitest casa
# só por extensão TS, então um push só de migration não as rodava.
#
# Duas decisões, cada uma contra um furo do desenho anterior (lista à mão no
# `files:` e no `entry` do .pre-commit-config.yaml):
#   - As suítes saem de uma varredura: todo teste de src/ que lê arquivo
#     (readFileSync/readdirSync) e cita um desses caminhos, ou que traz o
#     marcador `@vitest-non-ts-inputs` (a que varre o repositório inteiro, sem
#     citar caminho). Suíte nova entra sozinha. A varredura é textual: um
#     comentário que cite o caminho também conta.
#   - O disparo é decidido aqui, pelo diff do push com `--name-only` sem filtro
#     de status: o pre-commit não passa arquivo removido ao `files:`, e apagar
#     uma migration mudava o que model-registry lê sem rodar a suíte.
#
# `--list` imprime as suítes e sai. VITEST_BIN troca o binário (teste).

set -euo pipefail
cd "$(dirname "$0")/.."

# Caminhos de entrada, relativos à raiz do repositório, e o mesmo padrão como
# aparece no código dos testes (literal de caminho ou argumentos de join).
INPUTS='^(frontend/supabase/(migrations|tests)/|backend/|\.pre-commit-config\.yaml$)'
REFERENCE='"supabase", "(migrations|tests)"|supabase/(migrations|tests)\b|backend/|"backend"|pre-commit-config|@vitest-non-ts-inputs'

derive_suites() {
  # Duas etapas, e não um pipe numa substituição de processo, para que uma falha
  # do grep derrube o script em vez de virar lista vazia.
  readers="$(grep -rlE --include='*.test.ts' --include='*.test.tsx' 'readFileSync|readdirSync' src)"
  mapfile -t suites < <(grep -lE "${REFERENCE}" ${readers} | sort)
  if [[ ${#suites[@]} -eq 0 ]]; then
    # Sem arquivo, o vitest rodaria a suíte inteira, o custo que o hook evita.
    echo "a varredura não achou nenhuma suíte que leia esses caminhos" >&2
    exit 1
  fi
}

if [[ "${1:-}" == --list ]]; then
  derive_suites
  printf '%s\n' "${suites[@]}"
  exit 0
fi

# No pre-push, o pre-commit informa o intervalo do push. Fora dele (rodado à
# mão), roda sempre.
# O diff vai para uma variável antes do grep: com `grep -q` num pipe, o grep
# sai no primeiro acerto, o git morre de SIGPIPE num push grande e o pipefail
# leria o acerto como "pulado". Falha do git derruba o script (set -e).
# `--no-relative`: caminhos a partir da raiz mesmo com diff.relative. Três
# pontos, como o pre-commit: só o que o push traz.
if [[ -n "${PRE_COMMIT_FROM_REF:-}" && -n "${PRE_COMMIT_TO_REF:-}" ]]; then
  changed="$(git diff --no-relative --name-only "${PRE_COMMIT_FROM_REF}...${PRE_COMMIT_TO_REF}")"
  if ! grep -qE "${INPUTS}" <<<"${changed}"; then
    echo "nenhuma migration, suíte SQL, arquivo do backend ou config de hooks no push: pulado"
    exit 0
  fi
fi

derive_suites
VITEST="${VITEST_BIN:-./node_modules/.bin/vitest}"
if [[ ! -x "${VITEST}" ]]; then
  echo "vitest ausente em frontend/node_modules; rode (cd frontend && npm install)" >&2
  exit 1
fi
exec "${VITEST}" run "${suites[@]}"
