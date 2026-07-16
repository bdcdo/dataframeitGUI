-- Contratos das máquinas de estado e FKs compostas da issue #134.
--
-- Como rodar (após `npx supabase db reset`):
--   docker exec -i supabase_db_frontend psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/rls_workflows.test.sql
--
-- O arquivo usa somente o banco local e termina em ROLLBACK.

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_rejected(
  statement text,
  label text,
  expected_sqlstate text,
  expected_message_pattern text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  actual_sqlstate text;
  actual_message text;
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS
      actual_sqlstate = RETURNED_SQLSTATE,
      actual_message = MESSAGE_TEXT;

    IF actual_sqlstate IS DISTINCT FROM expected_sqlstate THEN
      RAISE EXCEPTION
        'rejeição incorreta em %: esperado SQLSTATE %, recebido % (%)',
        label, expected_sqlstate, actual_sqlstate, actual_message;
    END IF;
    IF expected_message_pattern IS NOT NULL
       AND actual_message NOT LIKE expected_message_pattern THEN
      RAISE EXCEPTION
        'mensagem incorreta em %: esperado LIKE %, recebido %',
        label, expected_message_pattern, actual_message;
    END IF;
    RETURN;
  END;

  RAISE EXCEPTION 'esperava rejeição em %, mas o statement foi aceito', label;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.assert_succeeds(statement text, label text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE statement;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'falha inesperada em %: SQLSTATE %: %', label, SQLSTATE, SQLERRM;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.assert_affected_rows(
  statement text,
  expected_rows bigint,
  label text
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  actual_rows bigint;
BEGIN
  EXECUTE statement;
  GET DIAGNOSTICS actual_rows = ROW_COUNT;
  IF actual_rows IS DISTINCT FROM expected_rows THEN
    RAISE EXCEPTION
      'rowcount incorreto em %: esperado %, recebido %',
      label, expected_rows, actual_rows;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.assert_integer_result(
  statement text,
  expected integer,
  label text
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  actual integer;
BEGIN
  EXECUTE statement INTO actual;
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION
      'resultado incorreto em %: esperado %, recebido %',
      label, expected, actual;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.assert_jsonb_result(
  statement text,
  expected jsonb,
  label text
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  actual jsonb;
BEGIN
  EXECUTE statement INTO actual;
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION
      'resultado incorreto em %: esperado %, recebido %',
      label, expected, actual;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION pg_temp.assert_rejected(text, text, text, text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION pg_temp.assert_succeeds(text, text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION pg_temp.assert_affected_rows(text, bigint, text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION pg_temp.assert_integer_result(text, integer, text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION pg_temp.assert_jsonb_result(text, jsonb, text)
  TO authenticated, service_role;

-- ========== Superfície pública ==========

DO $$
DECLARE
  signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.request_document_exclusion(uuid,uuid,text)',
    'public.decide_exclusion_request(uuid,uuid,public.exclusion_request_decision,text)',
    'public.set_response_schema_versions(uuid,jsonb)',
    'public.submit_compare_review(uuid,uuid,text,text,uuid,text,uuid[],uuid[],boolean)',
    'public.mark_compare_doc_reviewed(uuid,uuid)',
    'public.add_response_equivalence(uuid,uuid,text,uuid,uuid)',
    'public.remove_response_equivalence(uuid,uuid)',
    'public.set_review_resolution(uuid,uuid,boolean)',
    'public.submit_self_review(uuid,uuid,jsonb)',
    'public.submit_blind_arbitration(uuid,uuid,jsonb)',
    'public.submit_final_arbitration(uuid,uuid,jsonb)'
  ]
  LOOP
    IF to_regprocedure(signature) IS NULL THEN
      RAISE EXCEPTION 'RPC ausente: %', signature;
    END IF;
    IF has_function_privilege('anon', signature, 'EXECUTE')
       OR has_function_privilege('service_role', signature, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', signature, 'EXECUTE') THEN
      RAISE EXCEPTION 'grants incorretos: %', signature;
    END IF;
  END LOOP;
END;
$$;

DO $$
DECLARE
  signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.submit_compare_review(uuid,uuid,text,uuid,text,uuid,text,uuid[],uuid[])',
    'public.add_response_equivalence(uuid,uuid,text,uuid,uuid,uuid)',
    'public.remove_response_equivalence(uuid,uuid,uuid)',
    'public.set_review_resolution(uuid,uuid,boolean,uuid)',
    'public.submit_self_review(uuid,uuid,uuid,jsonb)',
    'public.submit_blind_arbitration(uuid,uuid,uuid,jsonb)',
    'public.submit_final_arbitration(uuid,uuid,uuid,jsonb)',
    'public.reconcile_auto_review_backlog(uuid,uuid,jsonb,uuid[])'
  ]
  LOOP
    IF to_regprocedure(signature) IS NOT NULL THEN
      RAISE EXCEPTION 'assinatura legada ainda exposta: %', signature;
    END IF;
  END LOOP;

  IF has_function_privilege(
    'authenticated',
    'public.assert_current_field_responses(uuid,uuid,text,uuid[])',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'validador privado exposto como RPC';
  END IF;
END;
$$;

DO $$
DECLARE
  signature text :=
    'public.reconcile_auto_review_backlog(uuid,uuid,jsonb)';
BEGIN
  IF to_regprocedure(signature) IS NULL
     OR has_function_privilege('anon', signature, 'EXECUTE')
     OR has_function_privilege('authenticated', signature, 'EXECUTE')
     OR NOT has_function_privilege('service_role', signature, 'EXECUTE') THEN
    RAISE EXCEPTION 'grants incorretos: %', signature;
  END IF;
END;
$$;

DO $$
DECLARE
  constraint_name text;
BEGIN
  FOREACH constraint_name IN ARRAY ARRAY[
    'member_email_links_canonical_membership_fk',
    'responses_project_document_fk',
    'responses_project_round_fk',
    'assignments_project_document_fk',
    'assignments_project_batch_fk',
    'reviews_project_document_fk',
    'reviews_project_document_chosen_response_fk',
    'project_comments_project_document_fk',
    'project_comments_project_parent_fk',
    'difficulty_resolutions_project_document_fk',
    'difficulty_resolutions_project_response_fk',
    'error_resolutions_project_document_fk',
    'note_resolutions_project_response_fk',
    'response_equivalences_project_document_fk',
    'response_equivalences_project_document_response_a_fk',
    'response_equivalences_project_document_response_b_fk',
    'field_reviews_project_document_fk',
    'field_reviews_project_document_human_response_fk',
    'field_reviews_project_document_llm_response_fk',
    'projects_current_project_round_fk',
    'rounds_project_source_batch_fk'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = constraint_name
        AND contype = 'f'
        AND convalidated
    ) THEN
      RAISE EXCEPTION 'FK composta ausente ou não validada: %', constraint_name;
    END IF;
  END LOOP;
END;
$$;

-- ========== Fixtures ==========

INSERT INTO auth.users (id, email) VALUES
  ('81000000-0000-0000-0000-000000000001', 'workflow-coord@example.test'),
  ('81000000-0000-0000-0000-000000000002', 'workflow-member@example.test'),
  ('81000000-0000-0000-0000-000000000003', 'workflow-arbitrator@example.test'),
  ('81000000-0000-0000-0000-000000000004', 'workflow-outsider@example.test'),
  ('81000000-0000-0000-0000-000000000009', 'workflow-other@example.test');

INSERT INTO public.projects (
  id, name, created_by, pydantic_hash, pydantic_fields, out_of_scope_enabled,
  schema_version_major, schema_version_minor, schema_version_patch
) VALUES
  (
    '82000000-0000-0000-0000-000000000001', 'Projeto workflows A',
    '81000000-0000-0000-0000-000000000001', 'schema-a',
    '[{"name":"campo","hash":"hash-campo"}]', true, 1, 0, 0
  ),
  (
    '82000000-0000-0000-0000-000000000009', 'Projeto workflows B',
    '81000000-0000-0000-0000-000000000009', 'schema-b',
    '[{"name":"campo","hash":"hash-outro"}]', true, 1, 0, 0
  );

INSERT INTO public.project_members (
  project_id, user_id, role, can_arbitrate, can_resolve
) VALUES
  (
    '82000000-0000-0000-0000-000000000001',
    '81000000-0000-0000-0000-000000000001', 'coordenador', true, true
  ),
  (
    '82000000-0000-0000-0000-000000000001',
    '81000000-0000-0000-0000-000000000002', 'pesquisador', false, false
  ),
  (
    '82000000-0000-0000-0000-000000000001',
    '81000000-0000-0000-0000-000000000003', 'pesquisador', true, false
  );

INSERT INTO public.documents (id, project_id, title, text) VALUES
  (
    '83000000-0000-0000-0000-000000000001',
    '82000000-0000-0000-0000-000000000001', 'Documento comparação', 'texto'
  ),
  (
    '83000000-0000-0000-0000-000000000002',
    '82000000-0000-0000-0000-000000000001', 'Documento aprovação', 'texto'
  ),
  (
    '83000000-0000-0000-0000-000000000003',
    '82000000-0000-0000-0000-000000000001', 'Documento rejeição', 'texto'
  ),
  (
    '83000000-0000-0000-0000-000000000009',
    '82000000-0000-0000-0000-000000000009', 'Documento outro projeto', 'texto'
  ),
  (
    '83000000-0000-0000-0000-000000000010',
    '82000000-0000-0000-0000-000000000001', 'Documento reconcile', 'texto'
  );

INSERT INTO public.responses (
  id, project_id, document_id, respondent_id, respondent_type,
  respondent_name, answers, justifications, is_latest, pydantic_hash,
  schema_version_major, schema_version_minor, schema_version_patch,
  version_inferred_from, answer_field_hashes
) VALUES
  (
    '84000000-0000-0000-0000-000000000001',
    '82000000-0000-0000-0000-000000000001',
    '83000000-0000-0000-0000-000000000001',
    '81000000-0000-0000-0000-000000000002', 'humano', 'Pesquisador',
    '{"campo":"humano atual"}', '{"campo":"justificativa humana"}',
    true, 'schema-a', 1, 0, 0, 'live_save', '{"campo":"hash-campo"}'
  ),
  (
    '84000000-0000-0000-0000-000000000002',
    '82000000-0000-0000-0000-000000000001',
    '83000000-0000-0000-0000-000000000001',
    NULL, 'llm', 'LLM',
    '{"campo":"llm atual"}', '{"campo":"justificativa llm"}',
    true, 'schema-a', 1, 0, 0, NULL, '{"campo":"hash-campo"}'
  ),
  (
    '84000000-0000-0000-0000-000000000003',
    '82000000-0000-0000-0000-000000000001',
    '83000000-0000-0000-0000-000000000001',
    NULL, 'llm', 'LLM histórico',
    '{"campo":"resposta histórica"}', '{}',
    false, 'schema-a', 1, 0, 0, NULL, '{"campo":"hash-campo"}'
  ),
  (
    '84000000-0000-0000-0000-000000000009',
    '82000000-0000-0000-0000-000000000009',
    '83000000-0000-0000-0000-000000000009',
    '81000000-0000-0000-0000-000000000009', 'humano', 'Outro',
    '{"campo":"outro"}', '{}',
    true, 'schema-b', 1, 0, 0, 'live_save', '{"campo":"hash-outro"}'
  ),
  (
    '84000000-0000-0000-0000-000000000051',
    '82000000-0000-0000-0000-000000000001',
    '83000000-0000-0000-0000-000000000010',
    '81000000-0000-0000-0000-000000000002', 'humano', 'Pesquisador',
    '{"campo":"humano reconcile"}', '{}',
    true, 'schema-a', 1, 0, 0, 'live_save', '{"campo":"hash-campo"}'
  ),
  (
    '84000000-0000-0000-0000-000000000052',
    '82000000-0000-0000-0000-000000000001',
    '83000000-0000-0000-0000-000000000010',
    NULL, 'llm', 'LLM reconcile',
    '{"campo":"llm reconcile"}', '{}',
    true, 'schema-a', 1, 0, 0, NULL, '{"campo":"hash-campo"}'
  );

INSERT INTO public.field_reviews (
  id, project_id, document_id, field_name, human_response_id, llm_response_id,
  self_reviewer_id
) VALUES (
  '85000000-0000-0000-0000-000000000001',
  '82000000-0000-0000-0000-000000000001',
  '83000000-0000-0000-0000-000000000001', 'campo',
  '84000000-0000-0000-0000-000000000001',
  '84000000-0000-0000-0000-000000000002',
  '81000000-0000-0000-0000-000000000002'
);

-- Uma linha por ramo terminal da auto-revisão. Separar documentos mantém a
-- conclusão de assignment observável em cada decisão.
INSERT INTO public.documents (id, project_id, title, text) VALUES
  ('83000000-0000-0000-0000-000000000004', '82000000-0000-0000-0000-000000000001', 'Documento equivalente', 'texto'),
  ('83000000-0000-0000-0000-000000000005', '82000000-0000-0000-0000-000000000001', 'Documento ambíguo', 'texto'),
  ('83000000-0000-0000-0000-000000000006', '82000000-0000-0000-0000-000000000001', 'Documento admite erro', 'texto');

INSERT INTO public.responses (
  id, project_id, document_id, respondent_id, respondent_type,
  respondent_name, answers, justifications, is_latest, pydantic_hash,
  schema_version_major, schema_version_minor, schema_version_patch,
  version_inferred_from, answer_field_hashes
) VALUES
  ('84000000-0000-0000-0000-000000000011', '82000000-0000-0000-0000-000000000001', '83000000-0000-0000-0000-000000000004', '81000000-0000-0000-0000-000000000002', 'humano', 'Pesquisador', '{"campo":"humano equivalente"}', '{}', true, 'schema-a', 1, 0, 0, 'live_save', '{"campo":"hash-campo"}'),
  ('84000000-0000-0000-0000-000000000012', '82000000-0000-0000-0000-000000000001', '83000000-0000-0000-0000-000000000004', NULL, 'llm', 'LLM', '{"campo":"llm equivalente"}', '{}', true, 'schema-a', 1, 0, 0, NULL, '{"campo":"hash-campo"}'),
  ('84000000-0000-0000-0000-000000000021', '82000000-0000-0000-0000-000000000001', '83000000-0000-0000-0000-000000000005', '81000000-0000-0000-0000-000000000002', 'humano', 'Pesquisador', '{"campo":"humano ambíguo"}', '{}', true, 'schema-a', 1, 0, 0, 'live_save', '{"campo":"hash-campo"}'),
  ('84000000-0000-0000-0000-000000000022', '82000000-0000-0000-0000-000000000001', '83000000-0000-0000-0000-000000000005', NULL, 'llm', 'LLM', '{"campo":"llm ambíguo"}', '{}', true, 'schema-a', 1, 0, 0, NULL, '{"campo":"hash-campo"}'),
  ('84000000-0000-0000-0000-000000000031', '82000000-0000-0000-0000-000000000001', '83000000-0000-0000-0000-000000000006', '81000000-0000-0000-0000-000000000002', 'humano', 'Pesquisador', '{"campo":"humano errado"}', '{}', true, 'schema-a', 1, 0, 0, 'live_save', '{"campo":"hash-campo"}'),
  ('84000000-0000-0000-0000-000000000032', '82000000-0000-0000-0000-000000000001', '83000000-0000-0000-0000-000000000006', NULL, 'llm', 'LLM', '{"campo":"llm correto"}', '{}', true, 'schema-a', 1, 0, 0, NULL, '{"campo":"hash-campo"}');

INSERT INTO public.field_reviews (
  id, project_id, document_id, field_name, human_response_id, llm_response_id,
  self_reviewer_id
) VALUES
  ('85000000-0000-0000-0000-000000000011', '82000000-0000-0000-0000-000000000001', '83000000-0000-0000-0000-000000000004', 'campo', '84000000-0000-0000-0000-000000000011', '84000000-0000-0000-0000-000000000012', '81000000-0000-0000-0000-000000000002'),
  ('85000000-0000-0000-0000-000000000021', '82000000-0000-0000-0000-000000000001', '83000000-0000-0000-0000-000000000005', 'campo', '84000000-0000-0000-0000-000000000021', '84000000-0000-0000-0000-000000000022', '81000000-0000-0000-0000-000000000002'),
  ('85000000-0000-0000-0000-000000000031', '82000000-0000-0000-0000-000000000001', '83000000-0000-0000-0000-000000000006', 'campo', '84000000-0000-0000-0000-000000000031', '84000000-0000-0000-0000-000000000032', '81000000-0000-0000-0000-000000000002');

INSERT INTO public.assignments (
  project_id, document_id, user_id, status, type
) VALUES
  ('82000000-0000-0000-0000-000000000001', '83000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000002', 'em_andamento', 'auto_revisao'),
  ('82000000-0000-0000-0000-000000000001', '83000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000003', 'em_andamento', 'arbitragem'),
  ('82000000-0000-0000-0000-000000000001', '83000000-0000-0000-0000-000000000004', '81000000-0000-0000-0000-000000000002', 'em_andamento', 'auto_revisao'),
  ('82000000-0000-0000-0000-000000000001', '83000000-0000-0000-0000-000000000005', '81000000-0000-0000-0000-000000000002', 'em_andamento', 'auto_revisao'),
  ('82000000-0000-0000-0000-000000000001', '83000000-0000-0000-0000-000000000006', '81000000-0000-0000-0000-000000000002', 'em_andamento', 'auto_revisao'),
  ('82000000-0000-0000-0000-000000000001', '83000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000002', 'pendente', 'comparacao');

-- Grants temporários servem apenas para provar que DML genérico continua
-- bloqueado por RLS/triggers. As escritas normais usam exclusivamente RPC.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.project_comments, public.documents, public.reviews,
  public.responses, public.response_equivalences, public.field_reviews
TO authenticated;
GRANT SELECT, DELETE ON public.rounds, public.assignment_batches TO authenticated;
GRANT SELECT ON public.projects, public.project_members TO authenticated;
GRANT SELECT, UPDATE ON public.field_reviews TO service_role;

-- ========== Reconciliação atômica do backlog ==========

CREATE OR REPLACE FUNCTION pg_temp.auto_review_payload(include_new boolean)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(jsonb_agg(to_jsonb(payload) ORDER BY document_id), '[]'::jsonb)
  FROM (
    SELECT field_review.document_id,
           field_review.field_name,
           field_review.human_response_id,
           field_review.llm_response_id,
           field_review.self_reviewer_id
    FROM public.field_reviews AS field_review
    WHERE field_review.project_id = '82000000-0000-0000-0000-000000000001'
      AND field_review.document_id <> '83000000-0000-0000-0000-000000000010'
    UNION ALL
    SELECT '83000000-0000-0000-0000-000000000010'::uuid,
           'campo'::text,
           '84000000-0000-0000-0000-000000000051'::uuid,
           '84000000-0000-0000-0000-000000000052'::uuid,
           '81000000-0000-0000-0000-000000000002'::uuid
    WHERE include_new
  ) AS payload;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.auto_review_payload(boolean) TO service_role;

SELECT set_config(
  'request.jwt.claims',
  '{}', true
);
SET LOCAL ROLE service_role;
SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.reconcile_auto_review_backlog(
      '82000000-0000-0000-0000-000000000001',
      '81000000-0000-0000-0000-000000000004',
      '[]'
    )
  $sql$,
  'outsider tentou reconciliar backlog',
  '42501',
  '%coordinator, creator, or master required%'
);
RESET ROLE;

SELECT set_config(
  'request.jwt.claims',
  '{}', true
);
SET LOCAL ROLE service_role;
SELECT pg_temp.assert_jsonb_result(
  $sql$
    SELECT public.reconcile_auto_review_backlog(
      '82000000-0000-0000-0000-000000000001',
      '81000000-0000-0000-0000-000000000001',
      pg_temp.auto_review_payload(true)
    )
  $sql$,
  '{"removedCount":0,"keptResolved":0}',
  'coordenador cria backlog'
);
RESET ROLE;

SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL ROLE service_role;
SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.reconcile_auto_review_backlog(
      '82000000-0000-0000-0000-000000000001',
      '81000000-0000-0000-0000-000000000001',
      '[{"document_id":"83000000-0000-0000-0000-000000000010"}]'
    )
  $sql$,
  'reconcile recebeu linha incompleta',
  '23514',
  '%invalid or duplicate rows%'
);
RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM public.field_reviews
       WHERE project_id = '82000000-0000-0000-0000-000000000001'
         AND document_id = '83000000-0000-0000-0000-000000000010'
         AND field_name = 'campo'
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.assignments
       WHERE project_id = '82000000-0000-0000-0000-000000000001'
         AND document_id = '83000000-0000-0000-0000-000000000010'
         AND user_id = '81000000-0000-0000-0000-000000000002'
         AND type = 'auto_revisao'
         AND status = 'pendente'
     ) THEN
    RAISE EXCEPTION 'reconcile não criou a fila canônica';
  END IF;
END;
$$;

SELECT set_config(
  'request.jwt.claims',
  '{}', true
);
SET LOCAL ROLE service_role;
SELECT pg_temp.assert_jsonb_result(
  $sql$
    SELECT public.reconcile_auto_review_backlog(
      '82000000-0000-0000-0000-000000000001',
      '81000000-0000-0000-0000-000000000001',
      pg_temp.auto_review_payload(false)
    )
  $sql$,
  '{"removedCount":1,"keptResolved":0}',
  'coordenador remove backlog pendente'
);
RESET ROLE;

DO $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM public.field_reviews
       WHERE project_id = '82000000-0000-0000-0000-000000000001'
         AND document_id = '83000000-0000-0000-0000-000000000010'
     )
     OR EXISTS (
       SELECT 1 FROM public.assignments
       WHERE project_id = '82000000-0000-0000-0000-000000000001'
         AND document_id = '83000000-0000-0000-0000-000000000010'
         AND type = 'auto_revisao'
     ) THEN
    RAISE EXCEPTION 'reconcile não removeu o assignment órfão';
  END IF;
  RAISE NOTICE 'OK reconcile: autorização, criação, remoção e órfãos atômicos';
END;
$$;

SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL ROLE service_role;
SELECT pg_temp.assert_jsonb_result(
  $sql$
    SELECT public.reconcile_auto_review_backlog(
      '82000000-0000-0000-0000-000000000001',
      '81000000-0000-0000-0000-000000000001',
      pg_temp.auto_review_payload(true)
    )
  $sql$,
  '{"removedCount":0,"keptResolved":0}',
  'coordenador recria backlog para testar preservação'
);
RESET ROLE;

UPDATE public.field_reviews
SET self_verdict = 'admite_erro',
    self_reviewed_at = transaction_timestamp()
WHERE project_id = '82000000-0000-0000-0000-000000000001'
  AND document_id = '83000000-0000-0000-0000-000000000010'
  AND field_name = 'campo';

SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL ROLE service_role;
SELECT pg_temp.assert_jsonb_result(
  $sql$
    SELECT public.reconcile_auto_review_backlog(
      '82000000-0000-0000-0000-000000000001',
      '81000000-0000-0000-0000-000000000001',
      pg_temp.auto_review_payload(false)
    )
  $sql$,
  '{"removedCount":0,"keptResolved":1}',
  'reconcile preserva review resolvido fora do backlog canônico'
);
RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.field_reviews
    WHERE project_id = '82000000-0000-0000-0000-000000000001'
      AND document_id = '83000000-0000-0000-0000-000000000010'
      AND field_name = 'campo'
      AND self_verdict = 'admite_erro'
  ) THEN
    RAISE EXCEPTION 'reconcile removeu review resolvido';
  END IF;
  RAISE NOTICE 'OK reconcile: contagens canônicas e preservação de resolvidos';
END;
$$;

-- ========== Acesso atual nas RPCs definer ==========

-- A identidade própria continua sendo retornada por
-- auth_user_member_identity_ids() depois da revogação. As RPCs precisam exigir
-- separadamente acesso atual ao projeto antes de tocar linhas históricas.
DELETE FROM public.project_members
WHERE project_id = '82000000-0000-0000-0000-000000000001'
  AND user_id = '81000000-0000-0000-0000-000000000002';

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"81000000-0000-0000-0000-000000000002"}', true
);
SET LOCAL ROLE authenticated;

SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.submit_compare_review(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000001', 'campo',
      'humano',
      '84000000-0000-0000-0000-000000000001', NULL,
      ARRAY[
        '84000000-0000-0000-0000-000000000001',
        '84000000-0000-0000-0000-000000000002'
      ]::uuid[], NULL, false
    )
  $sql$,
  'ex-membro tentou comparar', '42501', '%authenticated project actor%'
);

SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.add_response_equivalence(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000001', 'campo',
      '84000000-0000-0000-0000-000000000001',
      '84000000-0000-0000-0000-000000000002'
    )
  $sql$,
  'ex-membro tentou criar equivalência', '42501', '%authenticated project actor%'
);

SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.remove_response_equivalence(
      '82000000-0000-0000-0000-000000000001', gen_random_uuid()
    )
  $sql$,
  'ex-membro tentou remover equivalência', '42501', '%authenticated project actor%'
);

SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.set_review_resolution(
      '82000000-0000-0000-0000-000000000001', gen_random_uuid(), true
    )
  $sql$,
  'ex-membro tentou resolver review', '42501', '%authenticated project actor%'
);

SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.submit_self_review(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000001',
      '[{"fieldReviewId":"85000000-0000-0000-0000-000000000001","verdict":"admite_erro","justification":null}]'
    )
  $sql$,
  'ex-membro tentou auto-revisar', '42501', '%authenticated project actor%'
);

SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.submit_blind_arbitration(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000001',
      '[{"fieldReviewId":"85000000-0000-0000-0000-000000000001","verdict":"humano"}]'
    )
  $sql$,
  'ex-membro tentou arbitragem cega', '42501', '%eligible authenticated arbitrator%'
);

SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.submit_final_arbitration(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000001',
      '[{"fieldReviewId":"85000000-0000-0000-0000-000000000001","verdict":"humano","questionImprovementSuggestion":null,"arbitratorComment":null}]'
    )
  $sql$,
  'ex-membro tentou arbitragem final', '42501', '%eligible authenticated arbitrator%'
);
RESET ROLE;

INSERT INTO public.project_members (
  project_id, user_id, role, can_arbitrate, can_resolve
) VALUES (
  '82000000-0000-0000-0000-000000000001',
  '81000000-0000-0000-0000-000000000002', 'pesquisador', false, false
);

INSERT INTO public.member_email_links (
  project_id, member_user_id, email, linked_user_id, created_by
) VALUES (
  '82000000-0000-0000-0000-000000000001',
  '81000000-0000-0000-0000-000000000002',
  'workflow-alias@example.test',
  '81000000-0000-0000-0000-000000000004',
  '81000000-0000-0000-0000-000000000001'
);

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"81000000-0000-0000-0000-000000000004"}', true
);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.set_review_resolution(
      '82000000-0000-0000-0000-000000000001', gen_random_uuid(), true
    )
  $sql$,
  'alias canônico passou pelo contrato de identidade única',
  '23503', '%review not found%'
);

SELECT pg_temp.assert_rejected(
  $sql$
    INSERT INTO public.responses (
      project_id, document_id, respondent_id, respondent_type,
      respondent_name, answers, justifications, is_latest, pydantic_hash,
      schema_version_major, schema_version_minor, schema_version_patch,
      version_inferred_from, answer_field_hashes
    ) VALUES (
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000004',
      '81000000-0000-0000-0000-000000000004', 'humano', 'Conta vinculada',
      '{"campo":"identidade paralela"}', '{}', true, 'schema-a',
      1, 0, 0, 'live_save', '{"campo":"hash-campo"}'
    )
  $sql$,
  'alias tentou criar resposta com a identidade física',
  '42501', '%own human response%'
);

SELECT pg_temp.assert_affected_rows(
  $sql$
    UPDATE public.responses
    SET answers = answers
    WHERE id = '84000000-0000-0000-0000-000000000011'
  $sql$,
  1,
  'alias atualizou a resposta da identidade canônica'
);
RESET ROLE;

DELETE FROM public.member_email_links
WHERE project_id = '82000000-0000-0000-0000-000000000001'
  AND linked_user_id = '81000000-0000-0000-0000-000000000004';

DO $$
BEGIN
  RAISE NOTICE 'OK acesso: 7 RPCs exigem projeto atual e alias usa identidade canônica';
END;
$$;

-- ========== Pedidos de exclusão ==========

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"81000000-0000-0000-0000-000000000002"}', true
);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_succeeds(
  $sql$
    SELECT public.request_document_exclusion(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000002',
      'fora do escopo'
    )
  $sql$,
  'criação de pedido de exclusão'
);

SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.request_document_exclusion(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000002',
      'pedido concorrente'
    )
  $sql$,
  'segundo pedido pendente no mesmo documento',
  '23505',
  '%already has a pending%'
);

SELECT pg_temp.assert_affected_rows(
  $sql$
    UPDATE public.project_comments
    SET resolved_at = transaction_timestamp(),
        resolved_by = '81000000-0000-0000-0000-000000000002'
    WHERE document_id = '83000000-0000-0000-0000-000000000002'
      AND kind = 'exclusion_request'
  $sql$,
  0,
  'autor tentou aprovar o próprio pedido por UPDATE genérico'
);

SELECT pg_temp.assert_succeeds(
  $sql$
    SELECT public.request_document_exclusion(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000003',
      'também fora do escopo'
    )
  $sql$,
  'criação do pedido a rejeitar'
);
RESET ROLE;

DO $$
BEGIN
  IF (
    SELECT count(*) FROM public.project_comments
    WHERE project_id = '82000000-0000-0000-0000-000000000001'
      AND document_id = '83000000-0000-0000-0000-000000000002'
      AND kind = 'exclusion_request'
      AND resolved_at IS NULL
      AND rejected_at IS NULL
  ) <> 1 THEN
    RAISE EXCEPTION 'índice/contrato não preservou um único pedido pendente';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.documents
    WHERE id = '83000000-0000-0000-0000-000000000002'
      AND exclusion_pending_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'pedido não marcou exclusion_pending_at';
  END IF;
END;
$$;

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"81000000-0000-0000-0000-000000000001"}', true
);
SET LOCAL ROLE authenticated;

SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.decide_exclusion_request(
      '82000000-0000-0000-0000-000000000001',
      (
        SELECT id FROM public.project_comments
        WHERE document_id = '83000000-0000-0000-0000-000000000002'
          AND kind = 'exclusion_request'
      ),
      NULL::public.exclusion_request_decision, NULL
    )
  $sql$,
  'decisão de exclusão nula',
  '22023', '%decision is required%'
);

SELECT pg_temp.assert_succeeds(
  $sql$
    SELECT public.decide_exclusion_request(
      '82000000-0000-0000-0000-000000000001',
      (
        SELECT id FROM public.project_comments
        WHERE document_id = '83000000-0000-0000-0000-000000000002'
          AND kind = 'exclusion_request'
      ),
      'approve', NULL
    )
  $sql$,
  'aprovação atômica do pedido'
);

SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.decide_exclusion_request(
      '82000000-0000-0000-0000-000000000001',
      (
        SELECT id FROM public.project_comments
        WHERE document_id = '83000000-0000-0000-0000-000000000002'
          AND kind = 'exclusion_request'
      ),
      'reject', 'decisão concorrente tardia'
    )
  $sql$,
  'segunda decisão perdeu a corrida',
  '23514',
  '%no longer pending%'
);

SELECT pg_temp.assert_succeeds(
  $sql$
    SELECT public.decide_exclusion_request(
      '82000000-0000-0000-0000-000000000001',
      (
        SELECT id FROM public.project_comments
        WHERE document_id = '83000000-0000-0000-0000-000000000003'
          AND kind = 'exclusion_request'
      ),
      'reject', 'permanece no estudo'
    )
  $sql$,
  'rejeição atômica do pedido'
);
RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.documents
    WHERE id = '83000000-0000-0000-0000-000000000002'
      AND excluded_at IS NOT NULL
      AND excluded_by = '81000000-0000-0000-0000-000000000001'
      AND exclusion_pending_at IS NULL
  ) THEN
    RAISE EXCEPTION 'aprovação não excluiu documento e limpou pendência';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.project_comments
    WHERE document_id = '83000000-0000-0000-0000-000000000002'
      AND resolved_at IS NOT NULL
      AND rejected_at IS NULL
  ) THEN
    RAISE EXCEPTION 'trigger canônico não resolveu pedido aprovado';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.project_comments
    WHERE document_id = '83000000-0000-0000-0000-000000000003'
      AND rejected_at IS NOT NULL
      AND rejected_reason = 'permanece no estudo'
      AND resolved_by = '81000000-0000-0000-0000-000000000001'
  ) THEN
    RAISE EXCEPTION 'rejeição não canonizou estado/ator';
  END IF;
  RAISE NOTICE 'OK exclusão: criação única, transições e corrida decisória';
END;
$$;

-- ========== FKs compostas ==========

-- Fixtures de domínio rodam sem JWT; assim guards semânticos não confundem
-- a violação relacional com autorização do ator e a FK é a fonte observada.
SELECT set_config('request.jwt.claims', '{}', true);

SELECT pg_temp.assert_rejected(
  $sql$
    INSERT INTO public.assignments (
      project_id, document_id, user_id, status, type
    ) VALUES (
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000009',
      '81000000-0000-0000-0000-000000000002', 'concluido', 'codificacao'
    )
  $sql$,
  'assignment cross-project',
  '23503',
  '%assignments_project_document_fk%'
);

SELECT pg_temp.assert_rejected(
  $sql$
    INSERT INTO public.responses (
      project_id, document_id, respondent_type, respondent_name, answers,
      is_latest
    ) VALUES (
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000009',
      'llm', 'cross-project', '{}', true
    )
  $sql$,
  'response cross-project',
  '23503',
  '%responses_project_document_fk%'
);

SELECT pg_temp.assert_rejected(
  $sql$
    INSERT INTO public.project_comments (
      project_id, document_id, author_id, body
    ) VALUES (
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000009',
      '81000000-0000-0000-0000-000000000001', 'cross-project'
    )
  $sql$,
  'comment cross-project',
  '23503',
  '%project_comments_project_document_fk%'
);

SELECT pg_temp.assert_rejected(
  $sql$
    INSERT INTO public.response_equivalences (
      project_id, document_id, field_name, response_a_id, response_b_id,
      reviewer_id
    ) VALUES (
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000001', 'campo',
      '84000000-0000-0000-0000-000000000001',
      '84000000-0000-0000-0000-000000000009',
      '81000000-0000-0000-0000-000000000002'
    )
  $sql$,
  'equivalence cross-project',
  '23503',
  '%response_equivalences_project_document_response_b_fk%'
);

INSERT INTO public.documents (id, project_id, title, text) VALUES
  ('83000000-0000-0000-0000-000000000007', '82000000-0000-0000-0000-000000000001', 'Documento hard delete', 'texto'),
  ('83000000-0000-0000-0000-000000000008', '82000000-0000-0000-0000-000000000001', 'Documento rodada', 'texto');
INSERT INTO public.project_comments (
  id, project_id, document_id, author_id, body, kind
) VALUES (
  '87000000-0000-0000-0000-000000000001',
  '82000000-0000-0000-0000-000000000001',
  '83000000-0000-0000-0000-000000000007',
  '81000000-0000-0000-0000-000000000001', 'histórico do documento', 'note'
);
INSERT INTO public.rounds (id, project_id, label) VALUES (
  '86000000-0000-0000-0000-000000000001',
  '82000000-0000-0000-0000-000000000001', 'Rodada descartável'
);
INSERT INTO public.responses (
  id, project_id, document_id, respondent_type, respondent_name, answers,
  is_latest, round_id
) VALUES (
  '84000000-0000-0000-0000-000000000041',
  '82000000-0000-0000-0000-000000000001',
  '83000000-0000-0000-0000-000000000008',
  'llm', 'LLM da rodada', '{}', true,
  '86000000-0000-0000-0000-000000000001'
);
INSERT INTO public.assignment_batches (
  id, project_id, created_by, researchers_per_doc, label
) VALUES (
  '88000000-0000-0000-0000-000000000001',
  '82000000-0000-0000-0000-000000000001',
  '81000000-0000-0000-0000-000000000001', 1, 'Lote descartável'
);
UPDATE public.assignments
SET batch_id = '88000000-0000-0000-0000-000000000001'
WHERE project_id = '82000000-0000-0000-0000-000000000001'
  AND document_id = '83000000-0000-0000-0000-000000000006'
  AND user_id = '81000000-0000-0000-0000-000000000002';

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"81000000-0000-0000-0000-000000000001"}', true
);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_succeeds(
  $sql$DELETE FROM public.documents WHERE id = '83000000-0000-0000-0000-000000000007'$sql$,
  'hard delete de documento com comentário'
);
SELECT pg_temp.assert_succeeds(
  $sql$DELETE FROM public.rounds WHERE id = '86000000-0000-0000-0000-000000000001'$sql$,
  'delete de rodada limpa round_id por FK'
);
SELECT pg_temp.assert_succeeds(
  $sql$DELETE FROM public.assignment_batches WHERE id = '88000000-0000-0000-0000-000000000001'$sql$,
  'delete de lote limpa batch_id por FK'
);
RESET ROLE;

DO $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM public.project_comments
       WHERE id = '87000000-0000-0000-0000-000000000001'
     )
     OR EXISTS (
       SELECT 1 FROM public.documents
       WHERE id = '83000000-0000-0000-0000-000000000007'
     ) THEN
    RAISE EXCEPTION 'hard delete não aplicou o cascade documental';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM public.responses
       WHERE id = '84000000-0000-0000-0000-000000000041'
         AND round_id IS NULL
     ) THEN
    RAISE EXCEPTION 'delete de rodada não preservou response com round_id nulo';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM public.assignments
       WHERE project_id = '82000000-0000-0000-0000-000000000001'
         AND document_id = '83000000-0000-0000-0000-000000000006'
         AND user_id = '81000000-0000-0000-0000-000000000002'
         AND batch_id IS NULL
     ) THEN
    RAISE EXCEPTION 'delete de lote não preservou assignment com batch_id nulo';
  END IF;
END;
$$;

DO $$
BEGIN
  RAISE NOTICE 'OK constraints: escopo composto e ações referenciais são coerentes';
END;
$$;

-- As seções de comparação e arbitragem ficam abaixo para que o mesmo conjunto
-- de fixtures também valide snapshots e as três fases da máquina de estado.

-- ========== Comparação e snapshot canônico ==========

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"81000000-0000-0000-0000-000000000002"}', true
);
SET LOCAL ROLE authenticated;

SELECT pg_temp.assert_rejected(
  $sql$
    INSERT INTO public.reviews (
      project_id, document_id, field_name, reviewer_id, verdict,
      chosen_response_id, response_snapshot
    ) VALUES (
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000001', 'campo',
      '81000000-0000-0000-0000-000000000002', 'concordo',
      '84000000-0000-0000-0000-000000000001', '[]'
    )
  $sql$,
  'INSERT direto em reviews sem policy', '42501', '%row-level security%'
);

SELECT pg_temp.assert_rejected(
  $sql$
    INSERT INTO public.response_equivalences (
      project_id, document_id, field_name, response_a_id, response_b_id,
      reviewer_id
    ) VALUES (
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000001', 'campo',
      '84000000-0000-0000-0000-000000000001',
      '84000000-0000-0000-0000-000000000002',
      '81000000-0000-0000-0000-000000000002'
    )
  $sql$,
  'INSERT direto em response_equivalences sem policy',
  '42501', '%row-level security%'
);

-- Uma resposta presente contra outra sem a chave continua sendo divergência
-- na UI; o snapshot canônico contém apenas a linha que tem o campo.
SELECT pg_temp.assert_succeeds(
  $sql$
    SELECT public.submit_compare_review(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000001', 'campo',
      'concordo',
      '84000000-0000-0000-0000-000000000001', NULL,
      ARRAY['84000000-0000-0000-0000-000000000001'::uuid], NULL, false
    )
  $sql$,
  'comparação com uma única resposta que contém o campo'
);

-- O papel autenticado executa a RPC, mas não recebe SELECT direto na tabela
-- de assignments. A asserção do estado persistido roda como owner do teste.
RESET ROLE;
SELECT pg_temp.assert_integer_result(
  $sql$
    SELECT count(*)::integer
    FROM public.assignments
    WHERE project_id = '82000000-0000-0000-0000-000000000001'
      AND document_id = '83000000-0000-0000-0000-000000000001'
      AND user_id = '81000000-0000-0000-0000-000000000002'
      AND type = 'comparacao'
      AND status = 'em_andamento'
      AND completed_at IS NULL
  $sql$,
  1,
  'submit_compare_review mantém atribuição aberta explicitamente'
);
SET LOCAL ROLE authenticated;

-- A terceira response do documento é histórica (is_latest=false). O caller
-- envia o subconjunto qualificado pela UI; a RPC não deve exigir todas as
-- linhas que já existiram no documento.
SELECT pg_temp.assert_succeeds(
  $sql$
    SELECT public.submit_compare_review(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000001',
      'campo',
      'concordo',
      '84000000-0000-0000-0000-000000000001',
      'decisão de teste',
      ARRAY[
        '84000000-0000-0000-0000-000000000001'::uuid,
        '84000000-0000-0000-0000-000000000002'::uuid
      ],
      ARRAY[
        '84000000-0000-0000-0000-000000000001'::uuid,
        '84000000-0000-0000-0000-000000000002'::uuid
      ],
      true
    )
  $sql$,
  'review de subconjunto qualificado'
);

SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.submit_compare_review(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000001',
      'campo',
      'concordo', NULL, NULL,
      ARRAY[
        '84000000-0000-0000-0000-000000000001'::uuid,
        '84000000-0000-0000-0000-000000000001'::uuid
      ],
      NULL,
      false
    )
  $sql$,
  'IDs de comparação duplicados',
  '22023',
  '%must be unique%'
);

SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.submit_compare_review(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000001',
      'campo',
      'concordo',
      '84000000-0000-0000-0000-000000000003', NULL,
      ARRAY[
        '84000000-0000-0000-0000-000000000001'::uuid,
        '84000000-0000-0000-0000-000000000002'::uuid
      ],
      NULL,
      false
    )
  $sql$,
  'chosen response fora do subconjunto',
  '23514',
  '%must belong to the comparison set%'
);

SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.submit_compare_review(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000001',
      'campo',
      'concordo', NULL, NULL,
      ARRAY['84000000-0000-0000-0000-000000000003'::uuid],
      NULL,
      false
    )
  $sql$,
  'response histórica não é comparável',
  '23503',
  '%must be current rows%'
);

SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.submit_compare_review(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000001',
      'campo',
      'concordo', NULL, NULL,
      ARRAY['84000000-0000-0000-0000-000000000009'::uuid],
      NULL,
      false
    )
  $sql$,
  'response cross-project não é comparável',
  '23503',
  '%must be current rows%'
);

SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.add_response_equivalence(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000001', 'campo',
      '84000000-0000-0000-0000-000000000001',
      '84000000-0000-0000-0000-000000000003'
    )
  $sql$,
  'equivalência rejeita response histórica',
  '23503',
  '%must be current rows%'
);

SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.add_response_equivalence(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000001', 'campo_ausente',
      '84000000-0000-0000-0000-000000000001',
      '84000000-0000-0000-0000-000000000002'
    )
  $sql$,
  'equivalência rejeita campo ausente',
  '23503',
  '%must be current rows%'
);
RESET ROLE;

DO $$
DECLARE
  snapshot jsonb;
BEGIN
  SELECT response_snapshot INTO snapshot
  FROM public.reviews
  WHERE project_id = '82000000-0000-0000-0000-000000000001'
    AND document_id = '83000000-0000-0000-0000-000000000001'
    AND field_name = 'campo'
    AND reviewer_id = '81000000-0000-0000-0000-000000000002';

  IF jsonb_array_length(snapshot) <> 2
     OR snapshot->0->>'id' <> '84000000-0000-0000-0000-000000000001'
     OR snapshot->0->'answer' IS DISTINCT FROM '"humano atual"'::jsonb
     OR snapshot->1->>'id' <> '84000000-0000-0000-0000-000000000002'
     OR snapshot @> '[{"id":"84000000-0000-0000-0000-000000000003"}]' THEN
    RAISE EXCEPTION 'snapshot não foi construído canonicamente pelo banco: %', snapshot;
  END IF;
  IF (
    SELECT count(*) FROM public.response_equivalences
    WHERE project_id = '82000000-0000-0000-0000-000000000001'
      AND document_id = '83000000-0000-0000-0000-000000000001'
      AND field_name = 'campo'
  ) <> 1 THEN
    RAISE EXCEPTION 'submit_compare_review não criou uma equivalência canônica';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.assignments
    WHERE project_id = '82000000-0000-0000-0000-000000000001'
      AND document_id = '83000000-0000-0000-0000-000000000001'
      AND user_id = '81000000-0000-0000-0000-000000000002'
      AND type = 'comparacao'
      AND status = 'concluido'
      AND completed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'submit_compare_review não concluiu a atribuição explicitamente';
  END IF;
END;
$$;

-- Add é idempotente: repetir o mesmo par devolve a linha existente.
SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"81000000-0000-0000-0000-000000000002"}', true
);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_succeeds(
  $sql$
    SELECT public.add_response_equivalence(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000001', 'campo',
      '84000000-0000-0000-0000-000000000002',
      '84000000-0000-0000-0000-000000000001'
    )
  $sql$,
  'replay idempotente da equivalência'
);
RESET ROLE;

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"81000000-0000-0000-0000-000000000001"}', true
);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.set_review_resolution(
      '82000000-0000-0000-0000-000000000001',
      (
        SELECT id FROM public.reviews
        WHERE project_id = '82000000-0000-0000-0000-000000000001'
          AND document_id = '83000000-0000-0000-0000-000000000001'
          AND field_name = 'campo'
      ),
      NULL
    )
  $sql$,
  'resolução nula',
  '22023', '%p_resolved is required%'
);
SELECT pg_temp.assert_integer_result(
  $sql$
    SELECT public.set_review_resolution(
      '82000000-0000-0000-0000-000000000001',
      (
        SELECT id FROM public.reviews
        WHERE project_id = '82000000-0000-0000-0000-000000000001'
          AND document_id = '83000000-0000-0000-0000-000000000001'
          AND field_name = 'campo'
      ),
      true
    )
  $sql$,
  1,
  'coordenador resolve review alheio'
);
RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.reviews
    WHERE project_id = '82000000-0000-0000-0000-000000000001'
      AND document_id = '83000000-0000-0000-0000-000000000001'
      AND field_name = 'campo'
      AND resolved_at IS NOT NULL
      AND resolved_by = '81000000-0000-0000-0000-000000000001'
  ) THEN
    RAISE EXCEPTION 'resolução não persistiu timestamp e ator canônicos';
  END IF;
END;
$$;

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"81000000-0000-0000-0000-000000000002"}', true
);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_integer_result(
  $sql$
    SELECT public.set_review_resolution(
      '82000000-0000-0000-0000-000000000001',
      (
        SELECT id FROM public.reviews
        WHERE project_id = '82000000-0000-0000-0000-000000000001'
          AND document_id = '83000000-0000-0000-0000-000000000001'
          AND field_name = 'campo'
      ),
      false
    )
  $sql$,
  1,
  'autor reabre o próprio review'
);
RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.reviews
    WHERE project_id = '82000000-0000-0000-0000-000000000001'
      AND document_id = '83000000-0000-0000-0000-000000000001'
      AND field_name = 'campo'
      AND resolved_at IS NULL
      AND resolved_by IS NULL
  ) THEN
    RAISE EXCEPTION 'reabertura não limpou timestamp e ator';
  END IF;
END;
$$;

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"81000000-0000-0000-0000-000000000003"}', true
);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.remove_response_equivalence(
      '82000000-0000-0000-0000-000000000001',
      (
        SELECT id FROM public.response_equivalences
        WHERE project_id = '82000000-0000-0000-0000-000000000001'
          AND document_id = '83000000-0000-0000-0000-000000000001'
      )
    )
  $sql$,
  'outro membro não remove equivalência alheia',
  '42501',
  '%cannot remove%'
);
RESET ROLE;

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"81000000-0000-0000-0000-000000000002"}', true
);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_succeeds(
  $sql$
    SELECT public.remove_response_equivalence(
      '82000000-0000-0000-0000-000000000001',
      (
        SELECT id FROM public.response_equivalences
        WHERE project_id = '82000000-0000-0000-0000-000000000001'
          AND document_id = '83000000-0000-0000-0000-000000000001'
      )
    )
  $sql$,
  'autor remove equivalência e review relacionado'
);
RESET ROLE;

DO $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM public.response_equivalences
       WHERE project_id = '82000000-0000-0000-0000-000000000001'
         AND document_id = '83000000-0000-0000-0000-000000000001'
     )
     OR EXISTS (
       SELECT 1 FROM public.reviews
       WHERE project_id = '82000000-0000-0000-0000-000000000001'
         AND document_id = '83000000-0000-0000-0000-000000000001'
         AND reviewer_id = '81000000-0000-0000-0000-000000000002'
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.assignments
       WHERE project_id = '82000000-0000-0000-0000-000000000001'
         AND document_id = '83000000-0000-0000-0000-000000000001'
         AND user_id = '81000000-0000-0000-0000-000000000002'
         AND type = 'comparacao'
         AND status = 'pendente'
         AND completed_at IS NULL
     ) THEN
    RAISE EXCEPTION 'remoção de equivalência não limpou o estado relacionado';
  END IF;
END;
$$;

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"81000000-0000-0000-0000-000000000002"}', true
);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_integer_result(
  $sql$
    SELECT public.mark_compare_doc_reviewed(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000001'
    )
  $sql$,
  1,
  'conclusão explícita sem divergências restantes'
);
SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.mark_compare_doc_reviewed(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000002'
    )
  $sql$,
  'conclusão explícita sem atribuição',
  '23503',
  '%assignment not found%'
);
RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.assignments
    WHERE project_id = '82000000-0000-0000-0000-000000000001'
      AND document_id = '83000000-0000-0000-0000-000000000001'
      AND user_id = '81000000-0000-0000-0000-000000000002'
      AND type = 'comparacao'
      AND status = 'concluido'
      AND completed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'mark_compare_doc_reviewed não concluiu a atribuição';
  END IF;
  RAISE NOTICE 'OK comparação: estado explícito, equivalência e reabertura seletiva';
END;
$$;

-- ========== Auto-revisão e arbitragem ==========

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"81000000-0000-0000-0000-000000000002"}', true
);
SET LOCAL ROLE authenticated;

-- O caminho direto não existe mais. ROW_COUNT diferencia o bloqueio RLS de
-- uma atualização que teria passado pelo trigger.
SELECT pg_temp.assert_affected_rows(
  $sql$
    UPDATE public.field_reviews
    SET self_verdict = 'contesta_llm',
        self_reviewed_at = transaction_timestamp(),
        self_justification = 'tentativa direta'
    WHERE id = '85000000-0000-0000-0000-000000000001'
  $sql$,
  0,
  'DML autenticado direto em field_reviews'
);

SELECT pg_temp.assert_succeeds(
  $sql$
    SELECT public.submit_self_review(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000004',
      '[{"fieldReviewId":"85000000-0000-0000-0000-000000000011","verdict":"equivalente","justification":null}]'
    )
  $sql$,
  'self-review equivalente'
);

SELECT pg_temp.assert_succeeds(
  $sql$
    SELECT public.submit_self_review(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000005',
      '[{"fieldReviewId":"85000000-0000-0000-0000-000000000021","verdict":"ambiguo","justification":"o enunciado admite duas leituras"}]'
    )
  $sql$,
  'self-review ambígua'
);

SELECT pg_temp.assert_succeeds(
  $sql$
    SELECT public.submit_self_review(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000006',
      '[{"fieldReviewId":"85000000-0000-0000-0000-000000000031","verdict":"admite_erro","justification":null}]'
    )
  $sql$,
  'self-review admite erro'
);
RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.response_equivalences
    WHERE project_id = '82000000-0000-0000-0000-000000000001'
      AND document_id = '83000000-0000-0000-0000-000000000004'
      AND field_name = 'campo'
      AND response_a_id = '84000000-0000-0000-0000-000000000011'
      AND response_b_id = '84000000-0000-0000-0000-000000000012'
      AND reviewer_id = '81000000-0000-0000-0000-000000000002'
  ) THEN
    RAISE EXCEPTION 'ramo equivalente não criou a equivalência canônica';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.project_comments
    WHERE project_id = '82000000-0000-0000-0000-000000000001'
      AND document_id = '83000000-0000-0000-0000-000000000005'
      AND field_name = 'campo'
      AND author_id = '81000000-0000-0000-0000-000000000002'
      AND kind = 'note'
      AND body LIKE '%o enunciado admite duas leituras%'
  ) THEN
    RAISE EXCEPTION 'ramo ambíguo não criou o comentário canônico';
  END IF;
  IF (
    SELECT array_agg(self_verdict ORDER BY id)
    FROM public.field_reviews
    WHERE id IN (
      '85000000-0000-0000-0000-000000000011',
      '85000000-0000-0000-0000-000000000021',
      '85000000-0000-0000-0000-000000000031'
    )
  ) IS DISTINCT FROM ARRAY['equivalente', 'ambiguo', 'admite_erro'] THEN
    RAISE EXCEPTION 'ramos terminais não persistiram os vereditos esperados';
  END IF;
  IF (
    SELECT count(*) FROM public.assignments
    WHERE project_id = '82000000-0000-0000-0000-000000000001'
      AND document_id IN (
        '83000000-0000-0000-0000-000000000004',
        '83000000-0000-0000-0000-000000000005',
        '83000000-0000-0000-0000-000000000006'
      )
      AND user_id = '81000000-0000-0000-0000-000000000002'
      AND type = 'auto_revisao'
      AND status = 'concluido'
      AND completed_at IS NOT NULL
  ) <> 3 THEN
    RAISE EXCEPTION 'ramos terminais não concluíram os assignments';
  END IF;
END;
$$;

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"81000000-0000-0000-0000-000000000002"}', true
);
SET LOCAL ROLE authenticated;

-- O lote mistura uma decisão válida e um ID inexistente. A RPC valida o
-- conjunto completo antes de alterar a linha válida.
SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.submit_self_review(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000001',
      '[
        {
          "fieldReviewId":"85000000-0000-0000-0000-000000000001",
          "verdict":"contesta_llm",
          "justification":"a resposta humana está correta"
        },
        {
          "fieldReviewId":"85000000-0000-0000-0000-000000000009",
          "verdict":"admite_erro",
          "justification":null
        }
      ]'
    )
  $sql$,
  'lote self-review com linha inexistente',
  '42501',
  '%not found or owned%'
);

SELECT pg_temp.assert_succeeds(
  $sql$
    SELECT public.submit_self_review(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000001',
      '[{
        "fieldReviewId":"85000000-0000-0000-0000-000000000001",
        "verdict":"contesta_llm",
        "justification":"a resposta humana está correta"
      }]'
    )
  $sql$,
  'self-review válida'
);

SELECT pg_temp.assert_succeeds(
  $sql$
    SELECT public.submit_self_review(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000001',
      '[{
        "fieldReviewId":"85000000-0000-0000-0000-000000000001",
        "verdict":"contesta_llm",
        "justification":"a resposta humana está correta"
      }]'
    )
  $sql$,
  'replay idempotente da self-review'
);

SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.submit_self_review(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000001',
      '[{
        "fieldReviewId":"85000000-0000-0000-0000-000000000001",
        "verdict":"admite_erro",
        "justification":null
      }]'
    )
  $sql$,
  'replay divergente da self-review',
  '23514',
  '%different values%'
);
RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.field_reviews
    WHERE id = '85000000-0000-0000-0000-000000000001'
      AND self_verdict = 'contesta_llm'
      AND self_justification = 'a resposta humana está correta'
      AND self_reviewed_at > transaction_timestamp() - interval '1 minute'
  ) THEN
    RAISE EXCEPTION 'self-review não persistiu o estado canônico';
  END IF;
END;
$$;

-- Atribuição continua sendo uma operação administrativa separada e
-- derivável; o teste prepara o estado que as RPCs de árbitro recebem.
UPDATE public.field_reviews
SET arbitrator_id = '81000000-0000-0000-0000-000000000003'
WHERE id = '85000000-0000-0000-0000-000000000001';

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"81000000-0000-0000-0000-000000000003"}', true
);
SET LOCAL ROLE authenticated;

SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.submit_final_arbitration(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000001',
      '[{
        "fieldReviewId":"85000000-0000-0000-0000-000000000001",
        "verdict":"humano",
        "questionImprovementSuggestion":null,
        "arbitratorComment":null
      }]'
    )
  $sql$,
  'final antes da fase cega',
  '23514',
  '%requires assigned rows with a blind decision%'
);
RESET ROLE;

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"81000000-0000-0000-0000-000000000002"}', true
);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.submit_blind_arbitration(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000001',
      '[{
        "fieldReviewId":"85000000-0000-0000-0000-000000000001",
        "verdict":"humano"
      }]'
    )
  $sql$,
  'revisor original não é o árbitro atribuído',
  '42501',
  '%eligible authenticated arbitrator%'
);
RESET ROLE;

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"81000000-0000-0000-0000-000000000003"}', true
);
SET LOCAL ROLE authenticated;

SELECT pg_temp.assert_succeeds(
  $sql$
    SELECT public.submit_blind_arbitration(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000001',
      '[{
        "fieldReviewId":"85000000-0000-0000-0000-000000000001",
        "verdict":"humano"
      }]'
    )
  $sql$,
  'decisão cega válida'
);

SELECT pg_temp.assert_succeeds(
  $sql$
    SELECT public.submit_blind_arbitration(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000001',
      '[{
        "fieldReviewId":"85000000-0000-0000-0000-000000000001",
        "verdict":"humano"
      }]'
    )
  $sql$,
  'replay idempotente da decisão cega'
);

SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.submit_blind_arbitration(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000001',
      '[{
        "fieldReviewId":"85000000-0000-0000-0000-000000000001",
        "verdict":"llm"
      }]'
    )
  $sql$,
  'replay divergente da decisão cega',
  '23514',
  '%different verdict%'
);

SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.submit_final_arbitration(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000001',
      '[{
        "fieldReviewId":"85000000-0000-0000-0000-000000000001",
        "verdict":"llm",
        "questionImprovementSuggestion":null,
        "arbitratorComment":null
      }]'
    )
  $sql$,
  'decisão final LLM sem sugestão',
  '22023',
  '%decision is invalid%'
);

SELECT pg_temp.assert_succeeds(
  $sql$
    SELECT public.submit_final_arbitration(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000001',
      '[{
        "fieldReviewId":"85000000-0000-0000-0000-000000000001",
        "verdict":"llm",
        "questionImprovementSuggestion":"clarificar a pergunta",
        "arbitratorComment":"comentário final"
      }]'
    )
  $sql$,
  'decisão final válida'
);

SELECT pg_temp.assert_succeeds(
  $sql$
    SELECT public.submit_final_arbitration(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000001',
      '[{
        "fieldReviewId":"85000000-0000-0000-0000-000000000001",
        "verdict":"llm",
        "questionImprovementSuggestion":"clarificar a pergunta",
        "arbitratorComment":"comentário final"
      }]'
    )
  $sql$,
  'replay idempotente da decisão final'
);

SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.submit_final_arbitration(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000001',
      '[{
        "fieldReviewId":"85000000-0000-0000-0000-000000000001",
        "verdict":"humano",
        "questionImprovementSuggestion":null,
        "arbitratorComment":"mudou"
      }]'
    )
  $sql$,
  'replay divergente da decisão final',
  '23514',
  '%different values%'
);
RESET ROLE;

SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL ROLE service_role;
SELECT pg_temp.assert_rejected(
  $sql$
    UPDATE public.field_reviews
    SET blind_verdict = 'llm'
    WHERE id = '85000000-0000-0000-0000-000000000001'
  $sql$,
  'service_role tentou reescrever fase cega',
  '23514',
  '%blind arbitration decision is immutable%'
);
RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.field_reviews
    WHERE id = '85000000-0000-0000-0000-000000000001'
      AND blind_verdict = 'humano'
      AND blind_decided_at > transaction_timestamp() - interval '1 minute'
      AND final_verdict = 'llm'
      AND final_decided_at > transaction_timestamp() - interval '1 minute'
      AND question_improvement_suggestion = 'clarificar a pergunta'
      AND arbitrator_comment = 'comentário final'
  ) THEN
    RAISE EXCEPTION 'arbitragem não preservou o estado final canônico';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM public.assignments
       WHERE project_id = '82000000-0000-0000-0000-000000000001'
         AND document_id = '83000000-0000-0000-0000-000000000001'
         AND user_id = '81000000-0000-0000-0000-000000000002'
         AND type = 'auto_revisao'
         AND status = 'concluido'
         AND completed_at IS NOT NULL
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.assignments
       WHERE project_id = '82000000-0000-0000-0000-000000000001'
         AND document_id = '83000000-0000-0000-0000-000000000001'
         AND user_id = '81000000-0000-0000-0000-000000000003'
         AND type = 'arbitragem'
         AND status = 'concluido'
         AND completed_at IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'RPCs não concluíram os assignments de auto-revisão e arbitragem';
  END IF;
  RAISE NOTICE 'OK arbitragem: fases, lotes, idempotência e imutabilidade';
END;
$$;

ROLLBACK;
