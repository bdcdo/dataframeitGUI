-- Prova de serialização do `FOR UPDATE` de `schema_write_gate`.
--
-- Como rodar depois de `npx supabase start` e `npx supabase db reset`:
--   docker exec -i -e PGPASSWORD=postgres supabase_db_frontend \
--     psql -U supabase_admin -d postgres -X -v ON_ERROR_STOP=1 \
--     < supabase/tests/schema_revision_serialization.test.sql
--
-- Roda como `supabase_admin`, e não como `postgres` feito a suíte irmã, por uma
-- restrição do dblink: o pg_hba local autentica 127.0.0.1 por `trust`, e o
-- `dblink_connect` recusa abrir conexão sem senha quando quem chama não é
-- superusuário (o `postgres` do Supabase não é). É exigência do harness de
-- teste, não do código sob teste: as duas sessões concorrentes conectam como
-- `postgres` e assumem `authenticated` via SET LOCAL ROLE, exatamente como a
-- suíte irmã — o caminho de RLS exercitado é o mesmo.
--
-- Por que este arquivo existe separado de `schema_revision_rpcs.test.sql`:
-- aquele roda inteiro num BEGIN ... ROLLBACK, numa conexão só. Um lock nunca
-- colide consigo mesmo, então lá o `FOR UPDATE` nunca é disputado — apagar a
-- cláusula da migration deixa aquela suíte inteira verde. Provar serialização
-- exige duas sessões de verdade, e sessões separadas não enxergam fixtures de
-- uma transação aberta: por isso aqui os fixtures são commitados e removidos no
-- fim, em vez de revertidos.
--
-- O que se prova, e por que importa: o trigger `enforce_project_schema_revision`
-- já impede lost update mesmo sem o lock. Quem converte a corrida em `conflict`
-- limpo — o retorno que a UI de merge consome — é o `FOR UPDATE`. Sem ele, o
-- segundo escritor passa o CAS lendo a revisão pré-commit do primeiro, e só
-- morre no UPDATE, com 23514: o usuário recebe a copy genérica de "tente
-- novamente" e perde a edição, em vez da tela de merge. É essa diferença que a
-- asserção final mede.

CREATE EXTENSION IF NOT EXISTS dblink;

-- ----- Fixtures (commitados: as sessões concorrentes precisam enxergá-los) -----
-- Idempotente, para o arquivo poder rodar duas vezes seguidas sem db reset.
DELETE FROM public.projects WHERE id = '86000000-0000-0000-0000-000000000001';
DELETE FROM auth.users WHERE id = '86000000-0000-0000-0000-000000000002';

INSERT INTO auth.users (id, email) VALUES
  ('86000000-0000-0000-0000-000000000002', 'schema-serialization@example.test');

INSERT INTO public.projects (
  id, name, created_by, pydantic_fields, pydantic_code, pydantic_hash
) VALUES (
  '86000000-0000-0000-0000-000000000001',
  'schema serialization test',
  '86000000-0000-0000-0000-000000000002',
  '[{"name":"base_field"}]',
  'class Analysis: base',
  'hash-base'
);

INSERT INTO public.project_members (project_id, user_id, role) VALUES
  (
    '86000000-0000-0000-0000-000000000001',
    '86000000-0000-0000-0000-000000000002',
    'coordenador'
  );

-- O ambiente local não concede DML por default privileges; o remoto concede.
GRANT SELECT, UPDATE ON public.projects TO authenticated;
GRANT SELECT, INSERT ON public.schema_change_log TO authenticated;
GRANT SELECT ON public.project_members TO authenticated;

-- ----- Duas sessões concorrentes -----
SELECT dblink_connect(
  'writer_one',
  'dbname=postgres user=postgres host=127.0.0.1 port=5432'
);
SELECT dblink_connect(
  'writer_two',
  'dbname=postgres user=postgres host=127.0.0.1 port=5432'
);

-- T1 abre transação, escreve o schema e **não** commita: fica segurando o lock
-- da linha do projeto adquirido pelo `FOR UPDATE` do gate.
SELECT dblink_exec('writer_one', 'BEGIN');
SELECT dblink_exec(
  'writer_one',
  $cmd$SET LOCAL "request.jwt.claims" =
    '{"supabase_uid":"86000000-0000-0000-0000-000000000002"}'$cmd$
);
SELECT dblink_exec('writer_one', 'SET LOCAL ROLE authenticated');

CREATE TEMP TABLE writer_one_result AS
SELECT * FROM dblink(
  'writer_one',
  $cmd$SELECT status, schema_revision
  FROM public.commit_project_schema(
    '86000000-0000-0000-0000-000000000001',
    0,
    '[{"name":"field_from_t1"}]',
    'class Analysis: t1',
    0,
    2,
    0,
    'minor',
    '[{"field_name":"field_from_t1","change_summary":"t1","before_value":{},"after_value":{}}]',
    '86000000-0000-0000-0000-000000000002'
  )$cmd$
) AS t(status text, revision bigint);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM writer_one_result WHERE status = 'saved' AND revision = 1
  ) THEN
    RAISE EXCEPTION
      'FALHOU serialização: T1 não salvou — o cenário nem chegou a existir';
  END IF;

  RAISE NOTICE 'OK serialização: T1 salvou a revisão 1 e segue segurando o lock';
END;
$$;

-- T2 parte da MESMA revisão observada (0) — é a corrida real: dois coordenadores
-- que carregaram a tela juntos. `lock_timeout` existe para o teste falhar em
-- segundos caso o lock nunca seja liberado, em vez de pendurar a suíte.
SELECT dblink_exec('writer_two', 'BEGIN');
SELECT dblink_exec(
  'writer_two',
  $cmd$SET LOCAL "request.jwt.claims" =
    '{"supabase_uid":"86000000-0000-0000-0000-000000000002"}'$cmd$
);
SELECT dblink_exec('writer_two', $cmd$SET LOCAL lock_timeout = '10s'$cmd$);
SELECT dblink_exec('writer_two', 'SET LOCAL ROLE authenticated');

-- Assíncrono: a query fica bloqueada no servidor e o controle volta para cá.
SELECT dblink_send_query(
  'writer_two',
  $cmd$SELECT status, schema_revision
  FROM public.commit_project_schema(
    '86000000-0000-0000-0000-000000000001',
    0,
    '[{"name":"field_from_t2"}]',
    'class Analysis: t2',
    0,
    2,
    0,
    'minor',
    '[{"field_name":"field_from_t2","change_summary":"t2","before_value":{},"after_value":{}}]',
    '86000000-0000-0000-0000-000000000002'
  )$cmd$
);

-- ----- Asserção 1: T2 bloqueia enquanto T1 não commita -----
DO $$
DECLARE
  v_busy int;
  v_waiting boolean;
BEGIN
  PERFORM pg_sleep(1);
  v_busy := dblink_is_busy('writer_two');

  SELECT EXISTS (
    SELECT 1
    FROM pg_stat_activity
    WHERE wait_event_type = 'Lock'
      AND query LIKE '%field_from_t2%'
  ) INTO v_waiting;

  IF v_busy <> 1 THEN
    RAISE EXCEPTION
      'FALHOU serialização: T2 não ficou bloqueada com T1 segurando o lock';
  END IF;

  IF NOT v_waiting THEN
    RAISE EXCEPTION
      'FALHOU serialização: T2 está ocupada, mas não esperando por lock';
  END IF;

  RAISE NOTICE 'OK serialização: T2 bloqueia no lock enquanto T1 não commita';
END;
$$;

-- ----- T1 commita: T2 destrava e precisa reavaliar a revisão -----
SELECT dblink_exec('writer_one', 'COMMIT');

-- ----- Asserção 2: T2 resolve em `conflict`, não em exceção -----
-- Este é o ponto que discrimina o `FOR UPDATE`. Sem ele, T2 já teria passado o
-- CAS lendo revisão 0 e cairia aqui com 23514 (violação do trigger), abortando
-- o teste com erro em vez de devolver linha.
CREATE TEMP TABLE serialization_result AS
SELECT * FROM dblink_get_result('writer_two') AS t(status text, revision bigint);

-- A fila assíncrona só termina quando um get_result devolve zero linhas; sem
-- drená-la, a conexão recusa o próximo comando com "another command is already
-- in progress" e a limpeza morre antes das asserções de estado final.
SELECT count(*) FROM dblink_get_result('writer_two') AS t(status text, revision bigint);

DO $$
DECLARE
  v_status text;
  v_revision bigint;
  v_fields jsonb;
  v_log_count int;
BEGIN
  SELECT status, revision INTO v_status, v_revision FROM serialization_result;

  IF v_status IS DISTINCT FROM 'conflict' THEN
    RAISE EXCEPTION
      'FALHOU serialização: T2 devolveu status % em vez de conflict',
      coalesce(v_status, '<nenhuma linha>');
  END IF;

  IF v_revision <> 1 THEN
    RAISE EXCEPTION
      'FALHOU serialização: T2 devolveu revisão % em vez da revisão 1 de T1',
      v_revision;
  END IF;

  RAISE NOTICE 'OK serialização: T2 devolveu conflict com o snapshot de T1';
END;
$$;

-- ----- Asserção 3: a escrita de T2 não aconteceu -----
SELECT dblink_exec('writer_two', 'ROLLBACK');

DO $$
DECLARE
  v_fields jsonb;
  v_revision bigint;
  v_log_count int;
BEGIN
  SELECT pydantic_fields, schema_revision INTO v_fields, v_revision
  FROM public.projects
  WHERE id = '86000000-0000-0000-0000-000000000001';

  SELECT count(*) INTO v_log_count
  FROM public.schema_change_log
  WHERE project_id = '86000000-0000-0000-0000-000000000001';

  IF v_revision <> 1 OR v_fields <> '[{"name":"field_from_t1"}]'::jsonb THEN
    RAISE EXCEPTION
      'FALHOU serialização: estado final é revisão % / %, esperado 1 / T1',
      v_revision, v_fields;
  END IF;

  IF v_log_count <> 1 THEN
    RAISE EXCEPTION
      'FALHOU serialização: % entradas de log, esperada só a de T1',
      v_log_count;
  END IF;

  RAISE NOTICE 'OK serialização: só a escrita de T1 sobreviveu, sem lost update';
END;
$$;

-- ----- Limpeza -----
SELECT dblink_disconnect('writer_one');
SELECT dblink_disconnect('writer_two');

DROP TABLE serialization_result;
DROP TABLE writer_one_result;
DELETE FROM public.projects WHERE id = '86000000-0000-0000-0000-000000000001';
DELETE FROM auth.users WHERE id = '86000000-0000-0000-0000-000000000002';

REVOKE SELECT, UPDATE ON public.projects FROM authenticated;
REVOKE SELECT, INSERT ON public.schema_change_log FROM authenticated;
REVOKE SELECT ON public.project_members FROM authenticated;
