-- Auditoria reproduzível das superfícies RLS endurecidas pela issue #134.
--
-- Como rodar (após `npx supabase db reset`):
--   docker exec -i supabase_db_frontend psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/rls_audit.test.sql
--
-- O teste abre uma transação e desfaz fixtures e grants no final. As 11
-- policies SELECT recriadas pelo hardening são exercitadas por alias,
-- coordenador, criador sem membership, master, outsider e ex-membro.

BEGIN;

-- ========== Helpers fail-closed ==========

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

-- ========== Invariantes de catálogo ==========

DO $$
DECLARE
  relation_name text;
  object_name text;
BEGIN
  SELECT relation.relname INTO relation_name
  FROM pg_class AS relation
  WHERE relation.relnamespace = 'public'::regnamespace
    AND relation.relkind = 'r'
    AND NOT relation.relrowsecurity
  ORDER BY relation.relname
  LIMIT 1;
  IF relation_name IS NOT NULL THEN
    RAISE EXCEPTION 'tabela public sem RLS: %', relation_name;
  END IF;

  SELECT relation.relname INTO relation_name
  FROM pg_class AS relation
  WHERE relation.relnamespace = 'public'::regnamespace
    AND relation.relkind = 'r'
    AND NOT EXISTS (
      SELECT 1 FROM pg_policy AS policy WHERE policy.polrelid = relation.oid
    )
    AND (
      has_table_privilege(
        'anon', relation.oid,
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      )
      OR has_table_privilege(
        'authenticated', relation.oid,
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      )
    )
  ORDER BY relation.relname
  LIMIT 1;
  IF relation_name IS NOT NULL THEN
    RAISE EXCEPTION 'tabela sem policy exposta a papel de cliente: %', relation_name;
  END IF;

  SELECT policy.tablename || '.' || policy.policyname INTO object_name
  FROM pg_policies AS policy
  WHERE policy.schemaname = 'public'
    AND (
      btrim(lower(coalesce(policy.qual, '')), '() ') = 'true'
      OR btrim(lower(coalesce(policy.with_check, '')), '() ') = 'true'
    )
  ORDER BY policy.tablename, policy.policyname
  LIMIT 1;
  IF object_name IS NOT NULL THEN
    RAISE EXCEPTION 'policy literalmente permissiva: %', object_name;
  END IF;

  SELECT policy.tablename || '.' || policy.policyname INTO object_name
  FROM pg_policies AS policy
  WHERE policy.schemaname = 'public'
    AND policy.tablename IN (
      'reviews', 'response_equivalences', 'field_reviews'
    )
    AND policy.cmd <> 'SELECT'
  ORDER BY policy.tablename, policy.policyname
  LIMIT 1;
  IF object_name IS NOT NULL THEN
    RAISE EXCEPTION 'policy de write contorna RPC de domínio: %', object_name;
  END IF;

  SELECT relation.relname INTO object_name
  FROM pg_class AS relation
  WHERE relation.relnamespace = 'public'::regnamespace
    AND relation.relkind = 'v'
    AND NOT (
      coalesce(relation.reloptions, ARRAY[]::text[])
      @> ARRAY['security_invoker=true']
    )
  ORDER BY relation.relname
  LIMIT 1;
  IF object_name IS NOT NULL THEN
    RAISE EXCEPTION 'view sem security_invoker: %', object_name;
  END IF;

  SELECT procedure.oid::regprocedure::text INTO object_name
  FROM pg_proc AS procedure
  WHERE procedure.pronamespace = 'public'::regnamespace
    AND procedure.prosecdef
    AND NOT (
      coalesce(procedure.proconfig, ARRAY[]::text[])
      @> ARRAY['search_path=""']
    )
  ORDER BY procedure.oid::regprocedure::text
  LIMIT 1;
  IF object_name IS NOT NULL THEN
    RAISE EXCEPTION 'SECURITY DEFINER sem search_path vazio: %', object_name;
  END IF;

  RAISE NOTICE 'OK catálogo: RLS, deny-by-default, policies, views e definers';
END;
$$;

DO $$
DECLARE
  exposed_trigger text;
BEGIN
  SELECT procedure.oid::regprocedure::text INTO exposed_trigger
  FROM pg_proc AS procedure
  JOIN pg_trigger AS trigger ON trigger.tgfoid = procedure.oid
  WHERE procedure.pronamespace = 'public'::regnamespace
    AND NOT trigger.tgisinternal
    AND (
      has_function_privilege('anon', procedure.oid, 'EXECUTE')
      OR has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
      OR has_function_privilege('service_role', procedure.oid, 'EXECUTE')
    )
  ORDER BY procedure.oid::regprocedure::text
  LIMIT 1;
  IF exposed_trigger IS NOT NULL THEN
    RAISE EXCEPTION 'função de trigger exposta como RPC: %', exposed_trigger;
  END IF;

  IF to_regprocedure('public.remove_answer_key(uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'RPC órfã remove_answer_key ainda existe';
  END IF;

  IF to_regclass('public.idx_assignment_batches_project_created') IS NULL THEN
    RAISE EXCEPTION 'índice de assignment_batches ausente';
  END IF;

  IF to_regprocedure(
       'public.apply_lottery_assignments(uuid,text,uuid,jsonb,boolean)'
     ) IS NOT NULL THEN
    RAISE EXCEPTION 'assinatura legada de apply_lottery_assignments ainda existe';
  END IF;

  IF to_regprocedure(
       'public.apply_lottery_assignments(uuid,text,uuid,jsonb,boolean,jsonb)'
     ) IS NULL
     OR has_function_privilege(
       'anon', 'public.apply_lottery_assignments(uuid,text,uuid,jsonb,boolean,jsonb)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.apply_lottery_assignments(uuid,text,uuid,jsonb,boolean,jsonb)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'public.apply_lottery_assignments(uuid,text,uuid,jsonb,boolean,jsonb)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'grants de apply_lottery_assignments incorretos';
  END IF;

  IF has_function_privilege(
       'anon',
       'public.replace_and_add_documents(uuid,uuid[],boolean,jsonb,jsonb)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.replace_and_add_documents(uuid,uuid[],boolean,jsonb,jsonb)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'public.replace_and_add_documents(uuid,uuid[],boolean,jsonb,jsonb)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'grants de replace_and_add_documents incorretos';
  END IF;

  IF has_table_privilege('anon', 'public.final_answers', 'SELECT')
     OR has_table_privilege('anon', 'public.lottery_doc_stats', 'SELECT') THEN
    RAISE EXCEPTION 'anon ainda tem SELECT em view public';
  END IF;

  RAISE NOTICE 'OK superfície: funções de trigger fechadas e RPCs explícitas';
END;
$$;

-- Grants de teste vêm depois da auditoria de catálogo e somem no ROLLBACK.
-- Assim o arquivo não depende do bootstrap particular do Supabase local.
GRANT SELECT ON
  public.projects,
  public.project_members,
  public.profiles,
  public.difficulty_resolutions,
  public.error_resolutions,
  public.note_resolutions,
  public.llm_runs,
  public.rounds,
  public.project_comments,
  public.schema_suggestions,
  public.verdict_acknowledgments,
  public.reviews,
  public.documents
TO authenticated;

GRANT INSERT, UPDATE ON public.project_comments TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.assert_rejected(text, text, text, text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.assert_affected_rows(text, bigint, text)
  TO authenticated;

-- ========== Fixtures ==========

INSERT INTO auth.users (id, email) VALUES
  ('10000000-0000-0000-0000-000000000001', 'creator-rls@example.test'),
  ('10000000-0000-0000-0000-000000000002', 'coordinator-rls@example.test'),
  ('10000000-0000-0000-0000-000000000003', 'member-rls@example.test'),
  ('10000000-0000-0000-0000-000000000004', 'alias-rls@example.test'),
  ('10000000-0000-0000-0000-000000000006', 'master-rls@example.test'),
  ('10000000-0000-0000-0000-000000000007', 'outsider-rls@example.test');

INSERT INTO public.projects (
  id, name, created_by, pydantic_hash, pydantic_fields,
  schema_version_major, schema_version_minor, schema_version_patch,
  round_strategy
) VALUES (
  '20000000-0000-0000-0000-000000000001', 'Projeto da matriz',
  '10000000-0000-0000-0000-000000000001', 'schema-a',
  '[{"name":"campo","hash":"hash-campo"}]', 1, 2, 3, 'manual'
);

INSERT INTO public.project_members (project_id, user_id, role) VALUES
  (
    '20000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000002', 'coordenador'
  ),
  (
    '20000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000003', 'pesquisador'
  );

INSERT INTO public.member_email_links (
  id, project_id, member_user_id, email, linked_user_id, created_by
) VALUES (
  '21000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000003',
  'alias-rls@example.test',
  '10000000-0000-0000-0000-000000000004',
  '10000000-0000-0000-0000-000000000001'
);

INSERT INTO public.master_users (user_id) VALUES
  ('10000000-0000-0000-0000-000000000006');

INSERT INTO public.documents (id, project_id, title, text) VALUES (
  '30000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001', 'Documento da matriz', 'texto'
);

INSERT INTO public.rounds (id, project_id, label) VALUES (
  '31000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001', 'Rodada da matriz'
);

INSERT INTO public.llm_runs (id, project_id, job_id, status) VALUES (
  '32000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  '33000000-0000-0000-0000-000000000001', 'completed'
);

INSERT INTO public.responses (
  id, project_id, document_id, respondent_id, respondent_type,
  respondent_name, answers, is_latest, pydantic_hash,
  schema_version_major, schema_version_minor, schema_version_patch,
  version_inferred_from, answer_field_hashes
) VALUES (
  '50000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000003', 'humano', 'Membro',
  '{"campo":"resposta"}', true, 'schema-a', 1, 2, 3, 'live_save',
  '{"campo":"hash-campo"}'
);

INSERT INTO public.reviews (
  id, project_id, document_id, field_name, reviewer_id, verdict
) VALUES (
  '70000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001', 'campo',
  '10000000-0000-0000-0000-000000000003', 'concordo'
);

INSERT INTO public.difficulty_resolutions (
  id, project_id, response_id, document_id, resolved_by
) VALUES (
  '74000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  '50000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000002'
);

INSERT INTO public.error_resolutions (
  id, project_id, document_id, field_name, resolved_by
) VALUES (
  '74000000-0000-0000-0000-000000000002',
  '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001', 'campo',
  '10000000-0000-0000-0000-000000000002'
);

INSERT INTO public.note_resolutions (
  id, project_id, response_id, resolved_by
) VALUES (
  '74000000-0000-0000-0000-000000000003',
  '20000000-0000-0000-0000-000000000001',
  '50000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000002'
);

INSERT INTO public.project_comments (
  id, project_id, document_id, author_id, body
) VALUES (
  '34000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000003', 'Comentário da matriz'
);

INSERT INTO public.schema_suggestions (
  id, project_id, field_name, suggested_by, suggested_changes
) VALUES (
  '72000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001', 'campo',
  '10000000-0000-0000-0000-000000000003', '{}'
);

INSERT INTO public.verdict_acknowledgments (
  id, review_id, respondent_id, status
) VALUES (
  '73000000-0000-0000-0000-000000000001',
  '70000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000003', 'accepted'
);

-- ========== Matriz das 11 policies SELECT ==========

CREATE TEMP TABLE rls_read_cases (
  relation_name text PRIMARY KEY,
  predicate text NOT NULL
);

INSERT INTO rls_read_cases (relation_name, predicate) VALUES
  ('projects', 'id = ''20000000-0000-0000-0000-000000000001'''),
  (
    'project_members',
    'project_id = ''20000000-0000-0000-0000-000000000001'' AND user_id = ''10000000-0000-0000-0000-000000000003'''
  ),
  ('profiles', 'id = ''10000000-0000-0000-0000-000000000002'''),
  (
    'difficulty_resolutions',
    'id = ''74000000-0000-0000-0000-000000000001'''
  ),
  (
    'error_resolutions',
    'id = ''74000000-0000-0000-0000-000000000002'''
  ),
  (
    'note_resolutions',
    'id = ''74000000-0000-0000-0000-000000000003'''
  ),
  ('llm_runs', 'id = ''32000000-0000-0000-0000-000000000001'''),
  ('rounds', 'id = ''31000000-0000-0000-0000-000000000001'''),
  (
    'project_comments',
    'id = ''34000000-0000-0000-0000-000000000001'''
  ),
  (
    'schema_suggestions',
    'id = ''72000000-0000-0000-0000-000000000001'''
  ),
  (
    'verdict_acknowledgments',
    'id = ''73000000-0000-0000-0000-000000000001'''
  );

GRANT SELECT ON rls_read_cases TO authenticated;

DO $$
BEGIN
  IF (SELECT count(*) FROM rls_read_cases) <> 11 THEN
    RAISE EXCEPTION 'matriz incompleta: esperado 11 policies SELECT';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.assert_read_matrix(
  expected_rows bigint,
  role_name text
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  test_case record;
  actual_rows bigint;
BEGIN
  FOR test_case IN
    SELECT relation_name, predicate
    FROM rls_read_cases
    ORDER BY relation_name
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM public.%I WHERE %s',
      test_case.relation_name,
      test_case.predicate
    ) INTO actual_rows;

    IF actual_rows IS DISTINCT FROM expected_rows THEN
      RAISE EXCEPTION
        'matriz RLS falhou para % em %: esperado %, recebeu %',
        role_name, test_case.relation_name, expected_rows, actual_rows;
    END IF;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION pg_temp.assert_read_matrix(bigint, text)
  TO authenticated;

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"10000000-0000-0000-0000-000000000004"}', true
);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_read_matrix(1, 'alias');
RESET ROLE;

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"10000000-0000-0000-0000-000000000003"}', true
);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_read_matrix(1, 'membro direto');
RESET ROLE;

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"10000000-0000-0000-0000-000000000002"}', true
);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_read_matrix(1, 'coordenador');
RESET ROLE;

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"10000000-0000-0000-0000-000000000001"}', true
);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_read_matrix(1, 'criador sem membership');
RESET ROLE;

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"10000000-0000-0000-0000-000000000006"}', true
);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_read_matrix(1, 'master');
RESET ROLE;

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"10000000-0000-0000-0000-000000000007"}', true
);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_read_matrix(0, 'outsider');

-- UPDATE pode ser filtrado silenciosamente pela RLS. O rowcount explícito
-- impede que UPDATE 0 seja confundido com uma rejeição exercitada.
SELECT pg_temp.assert_affected_rows(
  $sql$
    UPDATE public.project_comments
    SET body = 'não autorizado'
    WHERE id = '34000000-0000-0000-0000-000000000001'
  $sql$,
  0,
  'outsider UPDATE filtrado pela RLS'
);

SELECT pg_temp.assert_rejected(
  $sql$
    INSERT INTO public.project_comments (
      project_id, document_id, author_id, body
    ) VALUES (
      '20000000-0000-0000-0000-000000000001',
      '30000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000007', 'não autorizado'
    )
  $sql$,
  'outsider INSERT bloqueado pela RLS',
  '42501',
  '%row-level security%'
);
RESET ROLE;

-- A posse de uma linha histórica não conserva acesso depois da revogação.
DELETE FROM public.member_email_links
WHERE id = '21000000-0000-0000-0000-000000000001';

DELETE FROM public.project_members
WHERE project_id = '20000000-0000-0000-0000-000000000001'
  AND user_id = '10000000-0000-0000-0000-000000000003';

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"10000000-0000-0000-0000-000000000004"}', true
);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_read_matrix(0, 'alias de ex-membro');
RESET ROLE;

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"10000000-0000-0000-0000-000000000003"}', true
);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_read_matrix(0, 'ex-membro direto');
RESET ROLE;

DO $$
BEGIN
  RAISE NOTICE
    'OK matriz: 11/11 policies SELECT, alias, papéis, outsider e revogação';
END;
$$;

ROLLBACK;
