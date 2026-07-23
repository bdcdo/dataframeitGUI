#!/usr/bin/env bash
# Gate de pre-commit do react-doctor. Ancorado em frontend/ (o react-doctor
# resolve config e escopo pelo diretorio de execucao). Detalhes e justificativa
# das supressoes em docs/LINT_CONFIG.md.
set -euo pipefail

cd "$(dirname "$0")/.." # frontend/

BIN=./node_modules/.bin/react-doctor
if [ ! -x "$BIN" ]; then
  echo "react-doctor ausente em frontend/node_modules; rode (cd frontend && npm install)" >&2
  exit 1
fi

# Guarda de versao. O hook invoca o binario PINADO direto (nao npx), justamente
# para respeitar o pino do package.json. Mas nada detectava um node_modules
# stale: um checkout preso na 0.5.8 enquanto o package.json ja pinava 0.7.8
# media com a ferramenta errada -- contagem e ate numero de linha divergentes --
# sem ninguem perceber. Aqui o gate falha fechado quando o instalado diverge do
# pino, em vez de medir com a versao errada.
pinned=$(node -p "require('./package.json').devDependencies['react-doctor'].replace(/^[^0-9]*/, '')")
installed=$(node -p "require('./node_modules/react-doctor/package.json').version")
if [ "$pinned" != "$installed" ]; then
  echo "react-doctor instalado ($installed) != pinado ($pinned); rode (cd frontend && npm install)" >&2
  exit 1
fi

# --scope changed --base HEAD: line-scoped, so bloqueia as LINHAS alteradas vs
# HEAD (o debito legado fica grandfathered). --blocking warning: agora que a
# contagem esta zerada (errors e warnings), o gate barra qualquer diagnostico
# novo -- error ou warning -- nas linhas tocadas. O pre-commit faz auto-stash
# dos unstaged, entao o working tree == staged e o diff enxerga o que vai ser
# commitado.
exec "$BIN" . --scope changed --base HEAD --blocking warning
