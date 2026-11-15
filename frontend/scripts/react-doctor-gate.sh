#!/usr/bin/env bash
# Gate de pre-commit do react-doctor. Ancorado em frontend/ (o react-doctor
# resolve config e escopo pelo diretorio de execucao). Detalhes e justificativa
# das supressoes em docs/LINT_CONFIG.md.
set -euo pipefail

cd "$(dirname "$0")/.." # frontend/

# Binario pinado presente e na versao do pino, ou falha fechado (porque em
# scripts/gates/lib/assert-pinned-version.sh, compartilhado com o fallow).
BIN=./node_modules/.bin/react-doctor
bash scripts/gates/lib/assert-pinned-version.sh react-doctor

# --scope lines --base HEAD: line-scoped, so bloqueia as LINHAS alteradas vs
# HEAD (o debito legado fica grandfathered). Nao --scope changed, que deixou de
# ser line-scoped (ver docs/LINT_CONFIG.md). --blocking warning: o gate barra
# qualquer diagnostico -- error ou warning -- nas linhas tocadas. O pre-commit
# faz auto-stash dos unstaged, entao o working tree == staged e o diff enxerga o
# que vai ser commitado.
exec "$BIN" . --scope lines --base HEAD --blocking warning
