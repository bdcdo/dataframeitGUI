#!/usr/bin/env bash
# Gate de pre-push do semgrep (SAST de JS/TS e Python), só achados NOVOS em
# relação ao origin/main. Decisões em docs/CODE_QUALITY_TOOLING.md.
#
# Achado (exit 1) reprova sempre. O que muda é o erro de infra (uvx ausente,
# rede, engine que não roda), decidido por GATE_FAIL_OPEN:
#   - 1 (default, o push local): avisa e libera, para não travar push offline;
#   - 0 (o ci.yml): reprova, depois de mais duas tentativas. No servidor, um
#     semgrep que não rodou não pode passar por verde.
#
# SEMGREP_UVX troca o binário (teste).
set -uo pipefail

cd "$(dirname "$0")/../.." # raiz do repositório

# Engine pinado: reprodutibilidade, e fuga da regressão da série 1.12x, que
# saía com exit 2 em execução limpa.
SEMGREP_VERSION=1.168.0
ATTEMPTS=3
UVX="${SEMGREP_UVX:-uvx}"
fail_open="${GATE_FAIL_OPEN:-1}"

infra_failure() {
  if [[ "$fail_open" == 0 ]]; then
    echo "semgrep não rodou ($1), e GATE_FAIL_OPEN=0 reprova" >&2
    exit 1
  fi
  echo "semgrep não rodou ($1): push liberado" >&2
  exit 0
}

command -v "$UVX" >/dev/null 2>&1 || infra_failure "uvx ausente"

# O `main` local costuma estar defasado, por isso origin/main primeiro.
base="$(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main 2>/dev/null || echo main)"

# Sem diferença nos diretórios escaneados não há achado novo possível. É o
# caso de todo push na própria main, em que a base é o HEAD.
if git diff --quiet "$base" HEAD -- frontend backend 2>/dev/null; then
  echo "semgrep: nada mudou em frontend/ ou backend/ desde ${base:0:12}"
  exit 0
fi

attempt=1
while :; do
  out="$("$UVX" --from "semgrep==${SEMGREP_VERSION}" semgrep scan \
    --config p/typescript --config p/react --config p/python \
    --baseline-commit "$base" --error --quiet frontend backend 2>&1)"
  code=$?
  [[ "$code" == 0 ]] && exit 0
  if [[ "$code" == 1 ]]; then
    echo "$out" >&2
    echo "semgrep achou problema novo — corrija ou marque com nosemgrep" >&2
    exit 1
  fi
  # Sem fail-closed não há nova tentativa: o push offline não espera três.
  if [[ "$fail_open" != 0 || "$attempt" -ge "$ATTEMPTS" ]]; then
    echo "$out" | tail -n 20 >&2
    infra_failure "exit $code, tentativa $attempt"
  fi
  echo "semgrep saiu com $code (tentativa $attempt de $ATTEMPTS); tentando de novo" >&2
  attempt=$((attempt + 1))
done
