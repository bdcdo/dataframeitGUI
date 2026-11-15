#!/usr/bin/env bash
# Gate de pre-push do fallow. Ancorado em frontend/, onde vivem o binario pinado
# e o .fallowrc.jsonc. Decisoes e medicoes em docs/CODE_QUALITY_TOOLING.md.
set -euo pipefail

cd "$(dirname "$0")/.." # frontend/

BIN=./node_modules/.bin/fallow
if [ ! -x "$BIN" ]; then
  echo "fallow ausente em frontend/node_modules; rode (cd frontend && npm install)" >&2
  exit 1
fi

bash scripts/gates/lib/assert-pinned-version.sh fallow

# Aviso do `fallow config` e config que deixou de valer, e o fallow so o
# escreve no stderr e sai 0 (#652). Os dois casos medidos: regra que o fallow
# nao conhece mais (renomeada ou removida upstream) vira letra morta no bloco
# `rules`, e um .fallowrc.json ao lado tem precedencia e faz o .fallowrc.jsonc
# ser ignorado inteiro. O `config` carrega a config sem rodar a analise.
if ! config_stderr=$("$BIN" config 2>&1 >/dev/null); then
  echo "$config_stderr" >&2
  echo "fallow config falhou; confira o frontend/.fallowrc.jsonc" >&2
  exit 1
fi
if grep -qw WARN <<<"$config_stderr"; then
  grep -w WARN <<<"$config_stderr" >&2
  echo "o fallow avisou sobre a config (acima): renomeie ou remova em rules a regra desconhecida, ou apague o arquivo que sombreia o frontend/.fallowrc.jsonc (ver docs/CODE_QUALITY_TOOLING.md)" >&2
  exit 1
fi

# --base origin/main: o gate responde o que ESTE PR introduz em relacao ao alvo
# do merge (o porque esta no comentario do hook em .pre-commit-config.yaml).
exec "$BIN" audit --base origin/main
