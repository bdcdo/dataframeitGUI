#!/usr/bin/env bash
#
# Roda uma suíte SQL contra o Supabase local.
#
# As suítes de contrato do banco vêm em dois formatos e só um deles é pgTAP:
# `responses_llm_actor_integrity` usa plan()/ok() e roda por `supabase test db`;
# as demais sinalizam falha com `RAISE EXCEPTION 'FALHOU ...'` e precisam de
# psql com ON_ERROR_STOP=1, que é o que este script faz. Sem ele as suítes só
# rodariam pelo docker exec escrito à mão no cabeçalho de cada arquivo — foi
# assim que 4.654 linhas de teste ficaram fora de todos os gates.
#
# O arquivo entra por stdin porque o psql roda dentro do container e não
# enxerga o filesystem do host.

set -euo pipefail

SQL_FILE="${1:-}"

if [[ -z "${SQL_FILE}" ]]; then
  echo "uso: run-sql-test.sh <caminho/para/suite.test.sql>" >&2
  exit 2
fi

if [[ ! -f "${SQL_FILE}" ]]; then
  echo "arquivo não encontrado: ${SQL_FILE}" >&2
  exit 2
fi

# Derivado do diretório do projeto pelo Supabase CLI; override para quem roda
# o banco com outro nome de container.
CONTAINER="${SUPABASE_DB_CONTAINER:-supabase_db_frontend}"

if ! docker inspect "${CONTAINER}" >/dev/null 2>&1; then
  echo "container ${CONTAINER} não está no ar — rode 'npx supabase start' antes." >&2
  exit 2
fi

echo "▸ ${SQL_FILE}"

# TCP no IP roteável do container em vez do socket unix, por dois motivos
# compostos das suítes com dblink (llm_rate_limit): (1) sobre socket,
# inet_server_addr()/inet_server_port() são NULL e a conexão derivada vira
# "port=", falhando em qualquer ambiente; (2) sobre 127.0.0.1 o pg_hba é
# trust, e dblink chamado por não-superuser (postgres não é superuser na
# imagem do Supabase) exige que a senha seja efetivamente usada — só as rotas
# privadas (172.16/12 etc.) autenticam por scram. PGPASSWORD idem.
#
# Assume o container numa única rede roteável (o caso do Supabase local). Se
# estiver em mais de uma, `println` emite um IP por linha e `grep -m1 .` pega o
# primeiro não-vazio — sem o `println`, o `range` concatenaria os IPs sem
# separador e produziria um host inválido.
CONTAINER_IP="$(docker inspect -f \
  '{{range .NetworkSettings.Networks}}{{println .IPAddress}}{{end}}' "${CONTAINER}" \
  | grep -m1 .)"

docker exec -e PGPASSWORD=postgres -i "${CONTAINER}" \
  psql -h "${CONTAINER_IP}" -p 5432 -U postgres -d postgres \
  -X -v ON_ERROR_STOP=1 \
  < "${SQL_FILE}"
