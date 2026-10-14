#!/usr/bin/env bash
# Rodada de estresse da suite Vitest: roda a suite completa N vezes com K lacos
# de CPU ocupada em paralelo e agrega as falhas por teste. Serve para provar uma
# correcao de teste intermitente sob carga (pratica descrita em
# docs/VERIFICATION.md): vermelho na arvore antiga, verde repetido na nova.
#
# Uso: npm run test:stress -- [--rounds N] [--cpu K] [--out DIR] [-- <args do vitest>]
#   --rounds  rodadas da suite (default 5)
#   --cpu     lacos de CPU ocupada durante as rodadas (default 8; 0 = so a carga
#             que a maquina ja tem)
#   --out     diretorio dos logs (default harness/<data>-vitest-stress-<hora>/
#             na raiz do repositorio, ignorado pelo .gitignore)
# Sai com 1 se alguma rodada falhar.
set -euo pipefail

cd "$(dirname "$0")/.." # frontend/

rounds=5
cpu=8
out=""
vitest_args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --rounds) rounds=$2; shift 2 ;;
    --cpu) cpu=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    --) shift; vitest_args=("$@"); break ;;
    *) echo "argumento desconhecido: $1" >&2; exit 2 ;;
  esac
done

BIN=./node_modules/.bin/vitest
if [ ! -x "$BIN" ]; then
  echo "vitest ausente em frontend/node_modules; rode (cd frontend && npm install)" >&2
  exit 1
fi

if [ -z "$out" ]; then
  out="$(git rev-parse --show-toplevel)/harness/$(date +%Y-%m-%d)-vitest-stress-$(date +%H%M%S)"
fi
mkdir -p "$out"

# O load average e a medida que torna rodadas comparaveis entre maquinas e dias:
# a mesma K produz cargas diferentes conforme o que mais esta rodando.
load() { if [ -r /proc/loadavg ]; then cut -d' ' -f1 /proc/loadavg; else echo "n/d"; fi; }

hogs=()
cleanup() { if [ ${#hogs[@]} -gt 0 ]; then kill "${hogs[@]}" 2>/dev/null || true; fi; }
trap cleanup EXIT INT TERM
for _ in $(seq 1 "$cpu"); do
  ( while :; do :; done ) &
  hogs+=($!)
done

echo "vitest-stress: $rounds rodada(s), $cpu laco(s) de CPU, logs em $out"
failures="$out/falhas.txt"
: > "$failures"
for r in $(seq 1 "$rounds"); do
  log="$out/rodada-$r.log"
  start=$(date +%s)
  # NO_COLOR deixa o log legivel e as linhas " FAIL " casaveis sem tirar ANSI.
  rc=0
  NO_COLOR=1 "$BIN" run "${vitest_args[@]}" > "$log" 2>&1 || rc=$?
  elapsed=$(( $(date +%s) - start ))
  summary=$(grep -E '^ +Tests ' "$log" | tail -1 | sed -E 's/ +/ /g; s/^ //')
  echo "rodada $r/$rounds: rc=$rc ${summary:-sem resumo} load=$(load) t=${elapsed}s"
  # O Vitest repete cada falha no relatorio final; sort -u conta uma por rodada.
  grep -E '^ FAIL ' "$log" | sed -E 's/^ FAIL +//' | sort -u | sed "s/^/$r\t/" >> "$failures" || true
  if [ "$rc" -ne 0 ] && ! grep -qE '^ FAIL ' "$log"; then
    printf '%s\t%s\n' "$r" "(rodada falhou sem teste nomeado; ver $log)" >> "$failures"
  fi
done

if [ -s "$failures" ]; then
  echo
  echo "falhas por teste (rodadas em que falhou):"
  cut -f2- "$failures" | sort | uniq -c | sort -rn
  exit 1
fi
echo "$rounds/$rounds rodadas verdes"
