-- Provas concorrentes do protocolo de locks da auto-revisão (PR #440).
--
-- Como rodar após `npx supabase db reset`:
--   docker exec -i supabase_db_frontend psql -U postgres -d postgres \
--     -X -v ON_ERROR_STOP=1 < supabase/tests/auto_review_assignment_concurrency.test.sql
--
-- Diferentemente dos testes transacionais comuns, as fixtures precisam estar
-- commitadas para duas conexões dblink enxergarem o mesmo estado. O arquivo usa
-- UUIDs reservados e remove tudo ao final.

CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;

DELETE FROM public.projects
WHERE id = '7b000000-0000-0000-0000-000000000001';
DELETE FROM auth.users
WHERE id IN (
  '7a000000-0000-0000-0000-000000000001',
  '7a000000-0000-0000-0000-000000000002'
);

INSERT INTO auth.users (id, email) VALUES
  ('7a000000-0000-0000-0000-000000000001', 'auto-concurrency-a@example.test'),
  ('7a000000-0000-0000-0000-000000000002', 'auto-concurrency-b@example.test');

INSERT INTO public.clerk_user_mapping
  (clerk_user_id, supabase_user_id, access_sync_version)
VALUES
  ('auto-concurrency-a', '7a000000-0000-0000-0000-000000000001', 1),
  ('auto-concurrency-b', '7a000000-0000-0000-0000-000000000002', 1);

INSERT INTO public.projects (id, name, created_by, pydantic_fields)
VALUES (
  '7b000000-0000-0000-0000-000000000001',
  'auto review concurrency',
  '7a000000-0000-0000-0000-000000000001',
  '[{"name":"q1"},{"name":"q2"}]'
);

INSERT INTO public.documents (id, project_id, title, text, text_hash) VALUES
  ('7c000000-0000-0000-0000-000000000001',
   '7b000000-0000-0000-0000-000000000001', 'doc a', 'texto a', 'h-concurrent-a'),
  ('7c000000-0000-0000-0000-000000000002',
   '7b000000-0000-0000-0000-000000000001', 'doc b', 'texto b', 'h-concurrent-b');

INSERT INTO public.project_members (project_id, user_id, role) VALUES
  ('7b000000-0000-0000-0000-000000000001',
   '7a000000-0000-0000-0000-000000000001', 'pesquisador'),
  ('7b000000-0000-0000-0000-000000000001',
   '7a000000-0000-0000-0000-000000000002', 'pesquisador');

INSERT INTO public.responses
  (id, project_id, document_id, respondent_id, respondent_type, answers)
VALUES
  ('7d000000-0000-0000-0000-000000000001',
   '7b000000-0000-0000-0000-000000000001',
   '7c000000-0000-0000-0000-000000000001',
   '7a000000-0000-0000-0000-000000000001', 'humano', '{"q1":"a","q2":"a"}'),
  ('7d000000-0000-0000-0000-000000000002',
   '7b000000-0000-0000-0000-000000000001',
   '7c000000-0000-0000-0000-000000000001',
   NULL, 'llm', '{"q1":"b","q2":"b"}'),
  ('7d000000-0000-0000-0000-000000000003',
   '7b000000-0000-0000-0000-000000000001',
   '7c000000-0000-0000-0000-000000000002',
   '7a000000-0000-0000-0000-000000000002', 'humano', '{"q1":"a","q2":"a"}'),
  ('7d000000-0000-0000-0000-000000000004',
   '7b000000-0000-0000-0000-000000000001',
   '7c000000-0000-0000-0000-000000000002',
   NULL, 'llm', '{"q1":"b","q2":"b"}');

INSERT INTO public.assignments
  (id, project_id, document_id, user_id, type, status)
VALUES (
  '7e000000-0000-0000-0000-000000000001',
  '7b000000-0000-0000-0000-000000000001',
  '7c000000-0000-0000-0000-000000000001',
  '7a000000-0000-0000-0000-000000000001',
  'auto_revisao',
  'pendente'
);

SELECT extensions.dblink_connect(
  'auto_review_a',
  'host=host.docker.internal port=54322 dbname=postgres user=postgres password=postgres'
);
SELECT extensions.dblink_connect(
  'auto_review_b',
  'host=host.docker.internal port=54322 dbname=postgres user=postgres password=postgres'
);

-- ========== sync vs assign ==========
SELECT extensions.dblink_exec('auto_review_a', 'BEGIN');
SELECT claims.value
FROM extensions.dblink(
  'auto_review_a',
  $$SELECT pg_catalog.set_config(
      'request.jwt.claims',
      '{"sub":"auto-concurrency-a","supabase_uid":"7a000000-0000-0000-0000-000000000001"}',
      false
  )$$
) AS claims(value TEXT);
SELECT extensions.dblink_exec('auto_review_a', 'SET ROLE authenticated');

-- A fecha a fila vazia, mas mantém membership+advisory+assignment travados.
SELECT result.closed
FROM extensions.dblink(
  'auto_review_a',
  $$SELECT public.sync_auto_review_assignment_status(
      '7b000000-0000-0000-0000-000000000001',
      '7c000000-0000-0000-0000-000000000001',
      '7a000000-0000-0000-0000-000000000001'
    )$$
) AS result(closed BOOLEAN);

-- B tenta criar q1 e deve esperar o lock da membership antes do advisory.
SELECT extensions.dblink_send_query(
  'auto_review_b',
  $$SELECT public.assign_auto_reviews_if_eligible(
      '[{"human_response_id":"7d000000-0000-0000-0000-000000000001",'
        '"llm_response_id":"7d000000-0000-0000-0000-000000000002",'
        '"field_names":["q1"]}]'::JSONB
    )$$
);
SELECT pg_catalog.pg_sleep(0.2);

DO $$
BEGIN
  IF extensions.dblink_is_busy('auto_review_b') <> 1 THEN
    RAISE EXCEPTION 'FALHOU sync vs assign: assign não esperou o lock';
  END IF;
END;
$$;

SELECT extensions.dblink_exec('auto_review_a', 'COMMIT');
SELECT *
FROM extensions.dblink_get_result('auto_review_b') AS result(created INTEGER);
SELECT *
FROM extensions.dblink_get_result('auto_review_b') AS result(created INTEGER);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.field_reviews
    WHERE document_id = '7c000000-0000-0000-0000-000000000001'
      AND field_name = 'q1'
      AND self_verdict IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM public.assignments
    WHERE id = '7e000000-0000-0000-0000-000000000001'
      AND status = 'pendente'
      AND completed_at IS NULL
  ) THEN
    RAISE EXCEPTION
      'FALHOU sync vs assign: trabalho novo não prevaleceu após o fechamento';
  END IF;
  RAISE NOTICE 'OK concorrência: assign espera sync e reabre a fila';
END;
$$;

-- ========== reconcile vs close ==========
-- A resolve q1 e fecha a fila sem commitar. B ainda enumera a versão pendente,
-- espera a membership e precisa revalidar o field_review depois do lock.
SELECT extensions.dblink_exec('auto_review_a', 'RESET ROLE');
SELECT extensions.dblink_exec('auto_review_a', 'BEGIN');
SELECT extensions.dblink_exec(
  'auto_review_a',
  $$UPDATE public.field_reviews
    SET self_verdict = 'admite_erro', self_reviewed_at = pg_catalog.now()
    WHERE document_id = '7c000000-0000-0000-0000-000000000001'
      AND field_name = 'q1'$$
);
SELECT extensions.dblink_exec('auto_review_a', 'SET ROLE authenticated');
SELECT result.closed
FROM extensions.dblink(
  'auto_review_a',
  $$SELECT public.sync_auto_review_assignment_status(
      '7b000000-0000-0000-0000-000000000001',
      '7c000000-0000-0000-0000-000000000001',
      '7a000000-0000-0000-0000-000000000001'
    )$$
) AS result(closed BOOLEAN);

SELECT extensions.dblink_send_query(
  'auto_review_b',
  $$SELECT public.reconcile_auto_review_assignments_with_pending(
      '7b000000-0000-0000-0000-000000000001'
    )$$
);
SELECT pg_catalog.pg_sleep(0.2);

DO $$
BEGIN
  IF extensions.dblink_is_busy('auto_review_b') <> 1 THEN
    RAISE EXCEPTION 'FALHOU reconcile vs close: reconcile não esperou o lock';
  END IF;
END;
$$;

SELECT extensions.dblink_exec('auto_review_a', 'COMMIT');
SELECT *
FROM extensions.dblink_get_result('auto_review_b') AS result(changed INTEGER);
SELECT *
FROM extensions.dblink_get_result('auto_review_b') AS result(changed INTEGER);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.assignments
    WHERE id = '7e000000-0000-0000-0000-000000000001'
      AND status = 'concluido'
  ) THEN
    RAISE EXCEPTION
      'FALHOU reconcile vs close: reconcile reabriu fila sem pendência atual';
  END IF;
  RAISE NOTICE 'OK concorrência: reconcile revalida após close e não reabre';
END;
$$;

-- ========== dois batches em ordem oposta ==========
SELECT extensions.dblink_exec('auto_review_a', 'RESET ROLE');
SELECT extensions.dblink_exec('auto_review_a', 'BEGIN');
SELECT result.created
FROM extensions.dblink(
  'auto_review_a',
  $$SELECT public.assign_auto_reviews_if_eligible(
      '[{"human_response_id":"7d000000-0000-0000-0000-000000000001",'
        '"llm_response_id":"7d000000-0000-0000-0000-000000000002",'
        '"field_names":["q2"]},'
        '{"human_response_id":"7d000000-0000-0000-0000-000000000003",'
        '"llm_response_id":"7d000000-0000-0000-0000-000000000004",'
        '"field_names":["q1"]}]'::JSONB
    )$$
) AS result(created INTEGER);

SELECT extensions.dblink_send_query(
  'auto_review_b',
  $$SELECT public.assign_auto_reviews_if_eligible(
      '[{"human_response_id":"7d000000-0000-0000-0000-000000000003",'
        '"llm_response_id":"7d000000-0000-0000-0000-000000000004",'
        '"field_names":["q1"]},'
        '{"human_response_id":"7d000000-0000-0000-0000-000000000001",'
        '"llm_response_id":"7d000000-0000-0000-0000-000000000002",'
        '"field_names":["q2"]}]'::JSONB
    )$$
);
SELECT pg_catalog.pg_sleep(0.2);

DO $$
BEGIN
  IF extensions.dblink_is_busy('auto_review_b') <> 1 THEN
    RAISE EXCEPTION 'FALHOU batches opostos: segundo lote não esperou locks';
  END IF;
END;
$$;

SELECT extensions.dblink_exec('auto_review_a', 'COMMIT');
SELECT *
FROM extensions.dblink_get_result('auto_review_b') AS result(created INTEGER);
SELECT *
FROM extensions.dblink_get_result('auto_review_b') AS result(created INTEGER);

DO $$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM public.field_reviews
    WHERE (document_id, field_name) IN (
      ('7c000000-0000-0000-0000-000000000001'::UUID, 'q2'),
      ('7c000000-0000-0000-0000-000000000002'::UUID, 'q1')
    )
  ) <> 2 THEN
    RAISE EXCEPTION 'FALHOU batches opostos: lote serializado perdeu trabalho';
  END IF;
  RAISE NOTICE 'OK concorrência: batches opostos terminam sem deadlock';
END;
$$;

-- ========== remoção de membership vs assign ==========
-- Limpa o trabalho do segundo documento para que a rejeição concorrente possa
-- provar ausência total de artefatos, não apenas ausência de um campo novo.
DELETE FROM public.assignments
WHERE document_id = '7c000000-0000-0000-0000-000000000002'
  AND user_id = '7a000000-0000-0000-0000-000000000002'
  AND type = 'auto_revisao';
DELETE FROM public.field_reviews
WHERE document_id = '7c000000-0000-0000-0000-000000000002';

-- O helper temporário vive na sessão B e converte a violação esperada em dado
-- observável pela sessão coordenadora, sem mascarar qualquer outra exceção.
SELECT extensions.dblink_exec(
  'auto_review_b',
  $$CREATE FUNCTION pg_temp.try_assign_removed_member()
    RETURNS TEXT
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      PERFORM public.assign_auto_reviews_if_eligible(
        '[{"human_response_id":"7d000000-0000-0000-0000-000000000003","llm_response_id":"7d000000-0000-0000-0000-000000000004","field_names":["q1"]}]'::JSONB
      );
      RETURN 'unexpected-success';
    EXCEPTION
      WHEN check_violation THEN
        RETURN 'rejected';
    END;
    $function$
  $$
);

SELECT extensions.dblink_exec('auto_review_a', 'BEGIN');
SELECT extensions.dblink_exec(
  'auto_review_a',
  $$DELETE FROM public.project_members
    WHERE project_id = '7b000000-0000-0000-0000-000000000001'
      AND user_id = '7a000000-0000-0000-0000-000000000002'$$
);

SELECT extensions.dblink_send_query(
  'auto_review_b',
  'SELECT pg_temp.try_assign_removed_member()'
);
SELECT pg_catalog.pg_sleep(0.2);

DO $$
BEGIN
  IF extensions.dblink_is_busy('auto_review_b') <> 1 THEN
    RAISE EXCEPTION
      'FALHOU remoção vs assign: assign não esperou a membership removida';
  END IF;
END;
$$;

SELECT extensions.dblink_exec('auto_review_a', 'COMMIT');
CREATE TEMP TABLE auto_review_removal_result (outcome TEXT NOT NULL);
INSERT INTO auto_review_removal_result (outcome)
SELECT result.outcome
FROM extensions.dblink_get_result('auto_review_b') AS result(outcome TEXT);
SELECT *
FROM extensions.dblink_get_result('auto_review_b') AS result(outcome TEXT);

DO $$
BEGIN
  IF (SELECT outcome FROM auto_review_removal_result) <> 'rejected'
     OR EXISTS (
       SELECT 1 FROM public.field_reviews
       WHERE document_id = '7c000000-0000-0000-0000-000000000002'
     )
     OR EXISTS (
       SELECT 1 FROM public.assignments
       WHERE document_id = '7c000000-0000-0000-0000-000000000002'
         AND user_id = '7a000000-0000-0000-0000-000000000002'
         AND type = 'auto_revisao'
     )
  THEN
    RAISE EXCEPTION
      'FALHOU remoção vs assign: membro removido deixou artefato de fila';
  END IF;
  RAISE NOTICE 'OK concorrência: remoção vence e assign rejeita sem artefatos';
END;
$$;

DROP TABLE auto_review_removal_result;

SELECT extensions.dblink_disconnect('auto_review_a');
SELECT extensions.dblink_disconnect('auto_review_b');

DELETE FROM public.projects
WHERE id = '7b000000-0000-0000-0000-000000000001';
DELETE FROM auth.users
WHERE id IN (
  '7a000000-0000-0000-0000-000000000001',
  '7a000000-0000-0000-0000-000000000002'
);
