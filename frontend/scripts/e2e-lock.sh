#!/usr/bin/env bash
# Roda o comando dado segurando a trava de maquina do E2E: uma execucao do
# Playwright por vez, em todas as worktrees e clones desta maquina.
#
# Uso: bash scripts/e2e-lock.sh <comando> [args...]
#   E2E_LOCK_FILE          arquivo da trava (default
#                          ${XDG_CACHE_HOME:-~/.cache}/dataframeitGUI/e2e.lock)
#   E2E_LOCK_WAIT_SECONDS  teto da espera pela trava, inteiro >= 0 (default 1800)
# Sai com o status do comando; com 1 se o flock faltar ou a espera estourar;
# com 2 em erro de uso.
#
# Por que serializar a execucao inteira, e nao isolar: os specs que mutam o
# banco resetam o MESMO projeto fixture do Supabase remoto com o MESMO usuario,
# entao duas execucoes simultaneas (dois `git push` em worktrees diferentes)
# apagam a response ou reabrem o assignment uma da outra no meio do teste. E o
# pre-push sobe o `next dev` na mesma porta (3100) em toda worktree, entao a
# segunda execucao morria em "http://localhost:3100 is already used". Uma trava
# de maquina resolve os dois: fixture e porta passam a ter um dono por vez.
# Nao cobre outra maquina (ou agente na nuvem) com o mesmo .env.e2e.
#
# O arquivo fica fora do repositorio para ser o mesmo em toda worktree e em
# todo clone, que compartilham o fixture. Ele mora em ~/.cache, e nao em
# $TMPDIR, porque sandboxes de agente trocam o $TMPDIR por sessao, e ai cada
# execucao teria a propria trava e nada seria excluido.
set -euo pipefail

if [ $# -eq 0 ]; then
  echo "uso: bash scripts/e2e-lock.sh <comando> [args...]" >&2
  exit 2
fi

lock="${E2E_LOCK_FILE:-${XDG_CACHE_HOME:-$HOME/.cache}/dataframeitGUI/e2e.lock}"
wait_seconds="${E2E_LOCK_WAIT_SECONDS:-1800}"
[[ "$wait_seconds" =~ ^[0-9]+$ ]] || {
  echo "E2E_LOCK_WAIT_SECONDS precisa ser inteiro >= 0: $wait_seconds" >&2
  exit 2
}

# Fail-closed: sem flock nao ha como garantir execucao exclusiva, e rodar sem a
# trava devolveria o gate ao estado em que um push derruba o do outro.
command -v flock >/dev/null 2>&1 || {
  echo "flock ausente (pacote util-linux; no macOS, brew install flock): sem ele o E2E nao consegue esperar a execucao de outra worktree" >&2
  exit 1
}

# O pre-commit so mostra a saida de um hook quando ele termina, entao um aviso
# de espera mandado ao stderr apareceria so depois dos minutos de espera. Quando
# o stderr nao e um terminal, o aviso vai tambem direto ao terminal de quem deu
# o push, se houver um.
avisar() {
  echo "e2e-lock: $*" >&2
  if [ ! -t 2 ]; then
    { echo "e2e-lock: $*" >/dev/tty; } 2>/dev/null || true
  fi
}

# Identificacao do dono atual, para os avisos de quem espera. O dono novo so a
# grava depois de tomar a trava, e o anterior esvazia o arquivo ao sair; quem
# chega nessa janela le o arquivo vazio, e sem a releitura lia a identificacao
# do dono ANTERIOR, que ja tinha saido (caso visto em 2026-10-14).
dono() {
  local conteudo _
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    conteudo="$(head -c 500 "$lock" 2>/dev/null || true)"
    if [ -n "$conteudo" ]; then
      printf '%s' "$conteudo"
      return
    fi
    sleep 0.2
  done
  printf '(o dono ainda nao gravou a identificacao)'
}

mkdir -p "$(dirname "$lock")"
# `<>` abre sem truncar: enquanto outro processo segura a trava, o conteudo e a
# identificacao dele, que quem espera le para dizer por quem esta esperando.
exec 9<>"$lock"
if ! flock -n 9; then
  avisar "outra execucao do E2E segura a trava: $(dono)"
  avisar "aguardando ate ${wait_seconds}s ($lock)"
  start=$SECONDS
  if ! flock -w "$wait_seconds" 9; then
    avisar "a trava continuou ocupada por ${wait_seconds}s; dono: $(dono)"
    avisar "confira se a execucao dona ainda roda; para pular o gate de forma explicita: SKIP=e2e-smoke git push"
    exit 1
  fi
  avisar "trava obtida apos $((SECONDS - start))s"
fi

# A trava e do descritor, nao do conteudo: truncar e reescrever o arquivo aqui
# nao a solta.
worktree="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
printf '%s (pid %s, desde %s): %s\n' "$worktree" "$$" "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >"$lock"

# O comando roda SEM o descritor 9 (`9>&-`). Se o herdasse, o `next dev` que o
# Playwright sobe tambem o herdaria, e um servidor orfao seguraria a trava para
# sempre: a proxima execucao esperaria o teto inteiro para falhar com uma
# mensagem que acusa a trava. Sem o descritor, quem segura e so este shell, e a
# trava cai quando ele sai, inclusive por SIGKILL. O orfao, se houver, aparece
# como "porta ja usada", que e o diagnostico certo.
status=0
"$@" 9>&- || status=$?
# Esvaziar ainda segurando a trava. Um dono morto por sinal deixa a identificacao
# para tras; o proximo dono a sobrescreve, e so um aviso emitido na janela entre
# as duas coisas sairia com o nome velho.
: >"$lock"
exit "$status"
