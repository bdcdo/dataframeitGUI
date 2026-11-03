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
#     recusa o start por falta de capacidade no host. O workflow a roda uma vez
#     por hora e não a cada passada.
#
# No modo "probe", com a sonda verde, o vigia também confere o relógio de cada
# Machine iniciada contra o do runner. Em 2026-11-03 uma Machine retomada de
# pausa (auto_stop "suspend") voltou com o relógio quase 11 h atrás e assim
# ficou por minutos; o health seguia verde, e o Clerk recusava toda sessão.
# Relógio errado não se conserta recriando Machine, então o vigia só avisa.
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
# Folga para a latência da requisição e o arredondamento a segundos; o atraso
# de 2026-11-03 foi de horas.
readonly max_clock_skew_seconds=30

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

# Uma requisição por Machine iniciada, presa a ela pelo cabeçalho
# fly-force-instance-id: com duas Machines, a sonda comum cai em qualquer uma, e
# em 2026-11-03 só uma das duas estava com o relógio errado. Health sem
# `server_time` também reprova, porque aí o relógio não foi conferido.
check_clocks() {
  local machine_id body server_time skew failed=""
  while read -r machine_id; do
    [[ -n "$machine_id" ]] || continue
    if ! body="$(curl -fsS --max-time 60 -H "fly-force-instance-id: $machine_id" "$health_url" </dev/null)" \
      || ! server_time="$(jq -er '.server_time | select(type == "number")' <<<"$body" 2>/dev/null)"; then
      summary "$app: a Machine $machine_id não informou server_time no health; relógio não conferido."
      failed=1
      continue
    fi
    skew="$(($(date +%s) - server_time))"
    skew="${skew#-}"
    if ((skew > max_clock_skew_seconds)); then
      summary "$app: o relógio da Machine $machine_id difere do runner em ${skew}s; reiniciar a Machine corrige."
      failed=1
    fi
  done < <(list_machines | jq -r '.[] | select(.state == "started") | .id')
  [[ -z "$failed" ]]
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

clock_failed=""
if [[ "$mode" == "probe" ]]; then
  if probe; then
    summary "$app: health respondeu."
    check_clocks || clock_failed=1
  else
    # Sonda vermelha com Machine fora de "started" não prova Machine presa. No
    # frontend, com tráfego baixo, o proxy acorda uma Machine e deixa a outra
    # suspensa, legitimamente; e uma falha de rede do runner deixa a sonda
    # vermelha sem nada errado no Fly. O que separa a pausada da presa é
    # mandar religá-la: a de 2026-08-10 recusava o start com "could not
    # reserve resource for machine: insufficient CPUs available".
    #
    # Só essa recusa condena a Machine. O start também falha por 5xx, timeout
    # ou 429 da API do Fly, por lease ocupado (deploy ou `machine update` fora
    # da fila do Actions) e por estado transitório (suspending, stopping,
    # replacing); em todos esses a Machine pode estar saudável, e recriá-la
    # seria derrubar a app para consertar nada. Por isso o padrão de capacidade
    # é casado no stderr, sem diferenciar maiúsculas, e qualquer outra falha só
    # vai para o summary. O stderr é repassado ao log do job para o diagnóstico
    # não se perder. O `</dev/null` impede o flyctl de consumir a lista que
    # alimenta o `read`.
    not_started_ids="$(list_machines | jq -r '.[] | select(.state != "started") | .id')"
    start_stderr="$(mktemp)"
    trap 'rm -f "$start_stderr"' EXIT
    start_failed_ids=""
    start_accepted=""
    start_failed_other=""
    while read -r machine_id; do
      [[ -n "$machine_id" ]] || continue
      if flyctl machine start "$machine_id" -a "$app" </dev/null 2>"$start_stderr"; then
        start_accepted=1
        cat "$start_stderr" >&2
        continue
      fi
      cat "$start_stderr" >&2
      if grep -Eqi 'insufficient|could not reserve|capacity' "$start_stderr"; then
        start_failed_ids+="$machine_id"$'\n'
      else
        start_failed_other=1
        summary "$app: o start da Machine $machine_id falhou por motivo que não é capacidade do host; nada recriado por isso."
      fi
    done <<<"$not_started_ids"
    # Nenhuma Machine condenada: recriar não resolve, e o vigia só avisa,
    # falhando o job. Se algum start foi aceito, a sonda roda de novo para
    # separar dois casos. Health verde quer dizer que o start manual trouxe a
    # app de volta, e mesmo assim é anomalia, porque o proxy devia tê-la
    # religado sozinho na primeira sonda. Health ainda vermelho com as Machines
    # iniciando põe o defeito na aplicação, na borda ou na rede do runner.
    if [[ -z "$start_failed_ids" && -z "$stuck_ids" ]]; then
      if [[ -n "$start_accepted" ]] && probe; then
        summary "$app: health voltou depois do start manual; o proxy não religou a app sozinho. Nada recriado."
      elif [[ -n "$start_failed_other" ]]; then
        summary "$app: health não respondeu e nenhuma Machine recusou o start por capacidade; nada recriado."
      else
        summary "$app: health não respondeu e as Machines iniciam; defeito fora do host, nada recriado."
      fi
      exit 1
    fi
    stuck_ids="$(printf '%s\n%s\n' "$stuck_ids" "$start_failed_ids" | sed '/^$/d' | sort -u)"
  fi
fi

if [[ -z "$stuck_ids" ]]; then
  summary "$app: nenhuma Machine presa."
  [[ -z "$clock_failed" ]]
  exit
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
