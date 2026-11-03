#!/usr/bin/env bash
# Vigia de uma app do Fly: acha Machine presa e a recria em outro host.
#
# Em 2026-08-10 a Machine do frontend parou por ociosidade e não voltou: o host
# de gru onde ela estava presa ficou sem CPU livre, o proxy insistiu em religá-la
# ali mesmo e o site só voltou quando alguém fez `machine clone` para outro host
# e destruiu a original. Este script é esse conserto, automático.
#
# Duas formas de reconhecer Machine presa:
#   - pelo estado e pelos eventos, sem tocar a app (não acorda Machine pausada):
#     estado "failed", ou crash em loop (saídas não pedidas em sequência) numa
#     Machine que não está de pé;
#   - pela sonda HTTP, só no modo "probe": se a URL de health não responde, o
#     vigia manda religar cada Machine fora de "started", e a presa é a que
#     recusa o start. A sonda acorda a app, por isso o workflow a roda uma vez
#     por hora e não a cada passada.
set -euo pipefail

app="${1:-}"
health_url="${2:-}"
mode="${3:-}"

if [[ -z "$app" || -z "$health_url" || ( -n "$mode" && "$mode" != "probe" ) ]]; then
  echo "uso: $0 <app> <url-de-health> [probe]" >&2
  exit 64
fi

readonly region="gru"
readonly crash_window_minutes=30
readonly crash_exits=3
readonly probe_attempts=3
readonly probe_interval_seconds=20

summary() {
  echo "$1"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    echo "- $1" >>"$GITHUB_STEP_SUMMARY"
  fi
}

list_machines() {
  flyctl machine list -a "$app" --json
}

probe() {
  local attempt
  for ((attempt = 1; attempt <= probe_attempts; attempt += 1)); do
    if curl -fsS --max-time 60 -o /dev/null "$health_url"; then
      return 0
    fi
    if ((attempt < probe_attempts)); then
      sleep "$probe_interval_seconds"
    fi
  done
  return 1
}

machines_json="$(list_machines)"
if ! jq -e 'type == "array"' >/dev/null <<<"$machines_json"; then
  echo "Não foi possível interpretar a lista de Machines de $app." >&2
  exit 1
fi

# `requested_stop` ausente conta como saída não pedida: o crash de 2026-08-10
# trazia `requested_stop=false`, e o abort do Node de 2026-11-01 nem trazia o
# campo. Deploy e escala marcam `requested_stop=true` e ficam de fora. Um crash
# isolado o Fly já religa sozinho; só a sequência dentro da janela é loop.
#
# O loop só conta em Machine fora de "started". Crash em loop que esgotou os
# restarts deixa a Machine "stopped"; a que está "started" voltou a subir e
# serve tráfego, e recriá-la mataria a run de LLM em curso na API por causa de
# crashes que já passaram. Pausa e retomada (eventos "suspension" e "start")
# não são "exit" e não entram na conta.
now_ms="$(($(date +%s) * 1000))"
stuck_ids="$(jq -r \
  --argjson since "$((now_ms - crash_window_minutes * 60 * 1000))" \
  --argjson exits "$crash_exits" '
  .[]
  | select(
      .state == "failed"
      or (.state != "started"
          and ([.events[]?
                | select(.type == "exit"
                    and .timestamp >= $since
                    and ((.request.exit_event.requested_stop // false) | not))]
               | length) >= $exits))
  | .id
' <<<"$machines_json")"

if [[ "$mode" == "probe" ]]; then
  if probe; then
    summary "$app: health respondeu."
  else
    # Sonda vermelha com Machine fora de "started" não prova Machine presa. No
    # frontend, com tráfego baixo, o proxy acorda uma Machine e deixa a outra
    # suspensa, legitimamente; e uma falha de rede do runner deixa a sonda
    # vermelha sem nada errado no Fly. O que separa a pausada da presa é
    # mandar religá-la: a de 2026-08-10 recusava o start com "could not
    # reserve resource ... insufficient CPUs available". Só a que recusa é
    # recriada. O `</dev/null` impede o flyctl de consumir a lista que
    # alimenta o `read`.
    not_started_ids="$(list_machines | jq -r '.[] | select(.state != "started") | .id')"
    start_failed_ids=""
    while read -r machine_id; do
      [[ -n "$machine_id" ]] || continue
      if ! flyctl machine start "$machine_id" -a "$app" </dev/null; then
        start_failed_ids+="$machine_id"$'\n'
      fi
    done <<<"$not_started_ids"
    # Todas as Machines iniciam (ou já estavam de pé) e o health segue sem
    # responder: o defeito está na aplicação, na borda ou na rede do runner,
    # e recriar Machine não o resolve. O vigia só avisa, falhando o job.
    if [[ -z "$start_failed_ids" && -z "$stuck_ids" ]]; then
      summary "$app: health não respondeu e as Machines iniciam; defeito fora do host, nada recriado."
      exit 1
    fi
    stuck_ids="$(printf '%s\n%s\n' "$stuck_ids" "$start_failed_ids" | sed '/^$/d' | sort -u)"
  fi
fi

if [[ -z "$stuck_ids" ]]; then
  summary "$app: nenhuma Machine presa."
  exit 0
fi

# Clona antes de destruir para não deixar a app sem Machine no meio do conserto,
# e na mesma região, porque os gates de deploy recusam Machine fora de gru. O
# clone herda a config da origem; quem escolhe o host é o scheduler do Fly, que
# não põe a Machine nova num host sem capacidade para ela.
# O `</dev/null` tem o mesmo motivo do laço de start acima.
while read -r stuck_id; do
  summary "$app: Machine $stuck_id presa; clonando em $region e destruindo a original."
  flyctl machine clone "$stuck_id" -a "$app" --region "$region" </dev/null
  flyctl machine destroy "$stuck_id" -a "$app" --force </dev/null
done <<<"$stuck_ids"

if probe; then
  summary "$app: health respondeu depois do conserto."
else
  summary "$app: health segue sem responder depois do conserto."
fi

# Falha de propósito mesmo com o conserto feito: recriar Machine em produção é
# incidente que alguém precisa saber que aconteceu, e a falha do job agendado é
# o que gera a notificação do GitHub.
exit 1
