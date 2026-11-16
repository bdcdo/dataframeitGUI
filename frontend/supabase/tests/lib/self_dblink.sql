-- Preâmbulo que o scripts/run-sql-test.sh executa antes de cada suíte psql:
-- a string de conexão das sessões concorrentes que as suítes abrem por dblink,
-- numa fonte só (#572, #921). Antes, seis suítes a copiavam em duas variantes.
--
-- Conecta no endereço e na porta da própria sessão, com senha: o
-- `dblink_connect` chamado por quem não é superusuário (o `postgres` do
-- Supabase não é) exige que a senha seja de fato usada, e sobre 127.0.0.1 o
-- pg_hba é `trust`, que não a usa. `hostaddr` com `host(...)`, e não
-- `host` com o `inet` cru, para não depender de resolução de nome.
--
-- Vive em pg_temp: some com a sessão e não toca o schema do banco local.
CREATE FUNCTION pg_temp.self_dblink_connstr() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT format(
    'hostaddr=%s port=%s dbname=%s user=postgres password=postgres',
    host(inet_server_addr()),
    inet_server_port(),
    current_database()
  )
$$;
