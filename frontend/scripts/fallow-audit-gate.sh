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

# Regra que o fallow nao conhece mais (renomeada ou removida upstream) vira
# letra morta no bloco `rules` do .fallowrc.jsonc: o fallow so avisa no stderr e
# sai 0, e o gate daquela regra deixa de existir sem nada mudar no repo (#652).
# O `config` e o comando que carrega a config sem rodar a analise.
if ! config_stderr=$("$BIN" config 2>&1 >/dev/null); then
  echo "$config_stderr" >&2
  echo "fallow config falhou; confira o frontend/.fallowrc.jsonc" >&2
  exit 1
fi
if grep -q "unknown rule" <<<"$config_stderr"; then
  grep "unknown rule" <<<"$config_stderr" >&2
  echo "o .fallowrc.jsonc fixa regra que o fallow instalado nao conhece; renomeie ou remova a chave em rules (ver docs/CODE_QUALITY_TOOLING.md)" >&2
  exit 1
fi

# --base origin/main: o gate responde o que ESTE PR introduz em relacao ao alvo
# do merge (o porque esta no comentario do hook em .pre-commit-config.yaml).
exec "$BIN" audit --base origin/main
