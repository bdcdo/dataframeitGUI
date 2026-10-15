#!/usr/bin/env bash
# Rodada de estresse da suite Vitest: roda a suite completa N vezes com K lacos
# de CPU ocupada em paralelo e agrega as falhas por teste. Serve para provar uma
# correcao de teste intermitente sob carga (pratica descrita em
# docs/VERIFICATION.md): vermelho na arvore antiga, verde repetido na nova.
#
# Uso: npm run test:stress -- [--rounds N] [--cpu K | --quota P] [--out DIR] [-- <args do vitest>]
#   --rounds  rodadas da suite, inteiro >= 1 (default 5)
#   --cpu     lacos de CPU ocupada durante as rodadas, inteiro >= 0 (default 8;
#             0 = so a carga que a maquina ja tem)
#   --quota   orcamento fixo de CPU da suite, em % de um nucleo (400 = 4
#             nucleos), via cgroup do systemd; dispensa os lacos (desligada por padrao)
#   --out     diretorio dos logs, relativo a quem chamou (default
#             harness/<data>-vitest-stress-<hora>/ na raiz do repositorio,
#             ignorado pelo .gitignore)
# Sai com 1 se alguma rodada falhar e com 2 em erro de uso.
#
# Com --cpu, a carga real e a soma dos lacos com o que mais roda na maquina, e
# duas rodadas com a mesma K podem ficar com load 45 e 100. Com --quota, a suite
# roda num escopo systemd com CPUQuota=P% e peso alto, e recebe P% de CPU nem
# mais nem menos enquanto a maquina tiver esse tanto livre para ela; a linha de
# cada rodada traz a CPU efetiva lida do cgroup, que e a prova de que o
# orcamento foi o declarado. W workers em P% equivalem, por processo, a um load
# de 100*N*W/P numa maquina de N threads.
set -euo pipefail

usage() { sed -n '7,16p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
need_value() { [ $# -ge 2 ] || { echo "falta o valor de $1" >&2; usage; }; }

# O npm roda o script com cwd em frontend/ e guarda o diretorio de quem chamou
# em INIT_CWD; fora do npm, o PWD antes do cd e esse diretorio.
caller_dir="${INIT_CWD:-$PWD}"
cd "$(dirname "$0")/.." # frontend/

rounds=5
cpu=""
quota=""
out=""
vitest_args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --rounds) need_value "$@"; rounds=$2; shift 2 ;;
    --cpu) need_value "$@"; cpu=$2; shift 2 ;;
    --quota) need_value "$@"; quota=$2; shift 2 ;;
    --out) need_value "$@"; out=$2; shift 2 ;;
    --) shift; vitest_args=("$@"); break ;;
    *) echo "argumento desconhecido: $1" >&2; usage ;;
  esac
done

# Validar aqui porque um `seq` invalido dentro de `for ... in $(...)` nao aciona
# o set -e: o laco simplesmente nao roda e o script declarava "rodadas verdes".
[[ "$rounds" =~ ^[1-9][0-9]*$ ]] || { echo "--rounds precisa ser inteiro >= 1: $rounds" >&2; usage; }
if [ -n "$quota" ]; then
  [[ "$quota" =~ ^[1-9][0-9]*$ ]] || { echo "--quota precisa ser inteiro >= 1: $quota" >&2; usage; }
  [ -z "$cpu" ] || { echo "--cpu e --quota sao alternativas" >&2; usage; }
  cpu=0
fi
cpu=${cpu:-8}
[[ "$cpu" =~ ^[0-9]+$ ]] || { echo "--cpu precisa ser inteiro >= 0: $cpu" >&2; usage; }

BIN=./node_modules/.bin/vitest
if [ ! -x "$BIN" ]; then
  echo "vitest ausente em frontend/node_modules; rode (cd frontend && npm install)" >&2
  exit 1
fi

if [ -z "$out" ]; then
  out="$(git rev-parse --show-toplevel)/harness/$(date +%Y-%m-%d)-vitest-stress-$(date +%H%M%S)"
elif [[ "$out" != /* ]]; then
  out="$caller_dir/$out"
fi
mkdir -p "$out"

# O load average e a medida que torna rodadas comparaveis entre maquinas e dias:
# a mesma K produz cargas diferentes conforme o que mais esta rodando.
load() { if [ -r /proc/loadavg ]; then cut -d' ' -f1 /proc/loadavg; else echo "n/d"; fi; }

# O libuv le o cpu.max do cgroup, e dentro do escopo os.availableParallelism()
# cai para a cota: o Vitest abriria menos workers e a cota so encolheria a suite
# em vez de sobrecarrega-la. O numero de workers e fixado no valor de fora do
# escopo, salvo quando quem chamou ja passou --maxWorkers.
runner=()
if [ -n "$quota" ]; then
  if ! systemd-run --user --scope -q true 2>/dev/null; then
    echo "--quota precisa de systemd-run --user com cgroup v2 (indisponivel aqui)" >&2
    exit 2
  fi
  runner=(systemd-run --user --scope -q -p "CPUQuota=${quota}%" -p CPUWeight=10000)
  case " ${vitest_args[*]-} " in
    *" --maxWorkers"*) ;;
    *) vitest_args+=("--maxWorkers=$(node -p 'Math.max(require("os").availableParallelism() - 1, 1)')") ;;
  esac
fi

# Roda o vitest no escopo e, antes de o escopo sumir, grava em $2 os
# microssegundos de CPU que ele consumiu. O trap repassa o sinal ao vitest,
# porque o processo que o script conhece e este bash, e nao o vitest.
scoped_vitest='
  stat=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)/cpu.stat
  out=$1; shift
  "$@" & child=$!
  trap "kill \$child 2>/dev/null" INT TERM
  wait $child; rc=$?
  awk "/^usage_usec/ { print \$2 }" "$stat" > "$out"
  exit $rc'

hogs=()
vitest_pid=""
cleanup() {
  if [ -n "$vitest_pid" ]; then kill "$vitest_pid" 2>/dev/null || true; fi
  if [ ${#hogs[@]} -gt 0 ]; then kill "${hogs[@]}" 2>/dev/null || true; fi
}
# Sem o exit, o trap de INT/TERM so limpava e o script seguia para a rodada
# seguinte sem os lacos, rodando com menos carga do que o cabecalho declara.
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for _ in $(seq 1 "$cpu"); do
  ( while :; do :; done ) &
  hogs+=($!)
done

if [ -n "$quota" ]; then
  echo "vitest-stress: $rounds rodada(s), cota de ${quota}% de CPU (${vitest_args[*]}), logs em $out"
else
  echo "vitest-stress: $rounds rodada(s), $cpu laco(s) de CPU, logs em $out"
fi
failures="$out/falhas.txt"
summary_file="$out/rodadas.txt"
: > "$failures"
: > "$summary_file"
for r in $(seq 1 "$rounds"); do
  log="$out/rodada-$r.log"
  start=$(date +%s)
  # NO_COLOR deixa o log legivel e as linhas " FAIL " casaveis sem tirar ANSI.
  # O vitest roda em segundo plano porque o bash so atende um sinal depois que o
  # processo em primeiro plano termina; o `wait` e interrompido pelo trap na hora.
  # A expansao ${arr[@]+...} evita o erro de array vazio sob set -u no bash < 4.4.
  rc=0
  usage_file="$out/rodada-$r.cpu"
  if [ -n "$quota" ]; then
    NO_COLOR=1 "${runner[@]}" bash -c "$scoped_vitest" _ "$usage_file" \
      "$BIN" run ${vitest_args[@]+"${vitest_args[@]}"} > "$log" 2>&1 &
  else
    NO_COLOR=1 "$BIN" run ${vitest_args[@]+"${vitest_args[@]}"} > "$log" 2>&1 &
  fi
  vitest_pid=$!
  wait "$vitest_pid" || rc=$?
  vitest_pid=""
  elapsed=$(( $(date +%s) - start ))
  # Um vitest que morre antes do relatorio nao imprime a linha "Tests"; o `|| true`
  # impede que o pipefail derrube o script antes do registro abaixo.
  summary=$({ grep -E '^ +Tests ' "$log" || true; } | tail -1 | sed -E 's/ +/ /g; s/^ //')
  line="rodada $r/$rounds: rc=$rc ${summary:-sem resumo} load=$(load) t=${elapsed}s"
  if [ -n "$quota" ]; then
    used=$(cat "$usage_file" 2>/dev/null || true)
    if [ -n "$used" ] && [ "$elapsed" -gt 0 ]; then
      line="$line cpu=$(LC_ALL=C awk -v u="$used" -v t="$elapsed" 'BEGIN { printf "%.2f", u / 1e6 / t }')/$(LC_ALL=C awk -v q="$quota" 'BEGIN { printf "%.2f", q / 100 }')"
    else
      line="$line cpu=n/d"
    fi
  fi
  echo "$line" | tee -a "$summary_file"
  if [ "$rc" -ne 0 ]; then
    # So as linhas FAIL do relatorio final, depois do banner "Failed Tests/Suites":
    # antes dele vem a saida dos proprios testes, que pode conter " FAIL ".
    awk '/Failed (Tests|Suites) [0-9]+/ { report = 1 } report && /^ FAIL / { sub(/^ FAIL +/, ""); print }' "$log" \
      | sort -u | sed "s/^/$r\t/" >> "$failures"
    if ! grep -q "^$r"$'\t' "$failures"; then
      printf '%s\t%s\n' "$r" "(rodada falhou sem teste nomeado; ver $log)" >> "$failures"
    fi
  fi
done

if [ -s "$failures" ]; then
  echo
  echo "falhas por teste (rodadas em que falhou):"
  cut -f2- "$failures" | sort | uniq -c | sort -rn
  exit 1
fi
echo "$rounds/$rounds rodadas verdes"
