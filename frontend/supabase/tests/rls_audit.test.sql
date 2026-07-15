-- Regressão da auditoria de RLS da issue #134.
--
-- Como rodar (após `npx supabase start` e `npx supabase db reset`):
--   psql "$(npx supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '\"')" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/rls_audit.test.sql
--
-- O teste roda em uma transação e termina em ROLLBACK. Além do inventário, ele
-- exercita INSERT e UPDATE por identidade direta, alias e service role.

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_rejected(statement text, label text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  rejected boolean := false;
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    rejected := true;
  END;

  IF NOT rejected THEN
    RAISE EXCEPTION 'esperava rejeição: %', label;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION pg_temp.assert_rejected(text, text)
  TO authenticated, service_role;

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

  -- Tabelas sem policies são deny-by-default. Elas só são aceitáveis
  -- como superfície service-only: nenhum papel de cliente pode ter DML. O
  -- service role pode ter grant direto (tabelas administrativas históricas)
  -- ou operar exclusivamente por RPC SECURITY DEFINER (#135).
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
  IF has_function_privilege('anon', 'public.apply_lottery_assignments(uuid,text,uuid,jsonb,boolean)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.apply_lottery_assignments(uuid,text,uuid,jsonb,boolean)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.apply_lottery_assignments(uuid,text,uuid,jsonb,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'grants de apply_lottery_assignments incorretos';
  END IF;
  IF has_function_privilege('anon', 'public.replace_and_add_documents(uuid,uuid[],boolean,jsonb,jsonb)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.replace_and_add_documents(uuid,uuid[],boolean,jsonb,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.replace_and_add_documents(uuid,uuid[],boolean,jsonb,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'grants de replace_and_add_documents incorretos';
  END IF;
  IF has_table_privilege('anon', 'public.final_answers', 'SELECT')
     OR has_table_privilege('anon', 'public.lottery_doc_stats', 'SELECT') THEN
    RAISE EXCEPTION 'anon ainda tem SELECT em view public';
  END IF;

  IF has_function_privilege('anon', 'public.unify_project_members(uuid,uuid,uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.unify_project_members(uuid,uuid,uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.unify_project_members(uuid,uuid,uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'grants de unify_project_members incorretos';
  END IF;

  IF to_regprocedure('public.remove_project_member(uuid,uuid)') IS NOT NULL
     AND NOT has_function_privilege(
       'authenticated', 'public.remove_project_member(uuid,uuid)', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'remove_project_member não executável por authenticated';
  END IF;

  RAISE NOTICE 'OK superfície: funções de trigger fechadas e RPCs explícitas';
END;
$$;

-- Prova o default ACL com uma função criada pelo mesmo papel que executa o
-- arquivo de teste (o DB_URL do Supabase usa postgres). A função é ligada a
-- um trigger para que a classificação futura também venha de pg_trigger.
CREATE TEMP TABLE future_trigger_probe (id integer);
CREATE FUNCTION public.rls_audit_future_trigger_probe()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN NEW;
END;
$$;
CREATE TRIGGER rls_audit_future_trigger_probe_trigger
  BEFORE INSERT ON future_trigger_probe
  FOR EACH ROW
  EXECUTE FUNCTION public.rls_audit_future_trigger_probe();

DO $$
BEGIN
  IF has_function_privilege(
       'anon', 'public.rls_audit_future_trigger_probe()', 'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated', 'public.rls_audit_future_trigger_probe()', 'EXECUTE'
     )
     OR has_function_privilege(
       'service_role', 'public.rls_audit_future_trigger_probe()', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'default ACL reexpôs função futura';
  END IF;
END;
$$;

-- ========== Fixtures ==========

INSERT INTO auth.users (id, email) VALUES
  ('10000000-0000-0000-0000-000000000001', 'creator-rls@example.test'),
  ('10000000-0000-0000-0000-000000000002', 'coordinator-rls@example.test'),
  ('10000000-0000-0000-0000-000000000003', 'member-rls@example.test'),
  ('10000000-0000-0000-0000-000000000004', 'alias-rls@example.test'),
  ('10000000-0000-0000-0000-000000000005', 'arbitrator-rls@example.test'),
  ('10000000-0000-0000-0000-000000000006', 'master-rls@example.test'),
  ('10000000-0000-0000-0000-000000000007', 'outsider-rls@example.test');

INSERT INTO public.projects (
  id, name, created_by, pydantic_hash, pydantic_fields,
  schema_version_major, schema_version_minor, schema_version_patch,
  round_strategy
) VALUES
  (
    '20000000-0000-0000-0000-000000000001', 'Projeto A',
    '10000000-0000-0000-0000-000000000001', 'schema-a',
    '[{"name":"campo","hash":"hash-campo"}]', 1, 2, 3, 'manual'
  ),
  (
    '20000000-0000-0000-0000-000000000002', 'Projeto B',
    '10000000-0000-0000-0000-000000000007', 'schema-b', '[]',
    4, 5, 6, 'schema_version'
  );

INSERT INTO public.project_members (project_id, user_id, role, can_arbitrate) VALUES
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'coordenador', true),
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003', 'pesquisador', false),
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000005', 'pesquisador', true);

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

INSERT INTO public.documents (id, project_id, title, text) VALUES
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Documento A1', 'texto'),
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'Documento A2', 'texto'),
  ('30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000002', 'Documento B', 'texto');

INSERT INTO public.rounds (id, project_id, label) VALUES
  ('31000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Rodada A'),
  ('31000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'Rodada B');

UPDATE public.projects
SET current_round_id = '31000000-0000-0000-0000-000000000001'
WHERE id = '20000000-0000-0000-0000-000000000001';

INSERT INTO public.llm_runs (id, project_id, job_id, status) VALUES
  ('32000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '33000000-0000-0000-0000-000000000001', 'completed');

INSERT INTO public.project_comments (id, project_id, document_id, author_id, body) VALUES
  ('34000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Comentário RLS'),
  ('34000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000007', 'Parent de outro projeto');

INSERT INTO public.assignment_batches (id, project_id, created_by, label) VALUES
  ('35000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Lote A'),
  ('35000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000007', 'Lote B');

INSERT INTO public.assignments (id, project_id, document_id, user_id, status, type) VALUES
  ('40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003', 'pendente', 'codificacao');

INSERT INTO public.responses (
  id, project_id, document_id, respondent_id, respondent_type, respondent_name,
  answers, is_latest, pydantic_hash, schema_version_major,
  schema_version_minor, schema_version_patch, version_inferred_from, round_id,
  answer_field_hashes
) VALUES
  (
    '50000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003',
    'humano', 'Membro', '{"campo":"humano"}', true, 'schema-a', 1, 2, 3,
    'live_save', '31000000-0000-0000-0000-000000000001',
    '{"campo":"hash-campo"}'
  ),
  (
    '50000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001', NULL,
    'llm', 'LLM', '{"campo":"llm"}', true, 'schema-a', 1, 2, 3, NULL, NULL,
    '{"campo":"hash-campo"}'
  ),
  (
    '50000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000002',
    '30000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000007',
    'humano', 'Outsider', '{}', true, 'schema-b', 4, 5, 6, 'live_save', NULL,
    '{}'
  );

INSERT INTO public.field_reviews (
  id, project_id, document_id, field_name, human_response_id, llm_response_id,
  self_reviewer_id, arbitrator_id
) VALUES (
  '60000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001', 'campo',
  '50000000-0000-0000-0000-000000000001',
  '50000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000003',
  '10000000-0000-0000-0000-000000000005'
);

-- ========== Matriz de leitura ==========

CREATE OR REPLACE FUNCTION pg_temp.assert_project_visible(expected boolean, role_name text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  checks jsonb;
  check_entry record;
BEGIN
  SELECT jsonb_build_object(
    'projects', EXISTS (
      SELECT 1 FROM public.projects
      WHERE id = '20000000-0000-0000-0000-000000000001'
    ),
    'project_members', EXISTS (
      SELECT 1 FROM public.project_members
      WHERE project_id = '20000000-0000-0000-0000-000000000001'
    ),
    'rounds', EXISTS (
      SELECT 1 FROM public.rounds
      WHERE project_id = '20000000-0000-0000-0000-000000000001'
    ),
    'llm_runs', EXISTS (
      SELECT 1 FROM public.llm_runs
      WHERE project_id = '20000000-0000-0000-0000-000000000001'
    ),
    'project_comments', EXISTS (
      SELECT 1 FROM public.project_comments
      WHERE project_id = '20000000-0000-0000-0000-000000000001'
    )
  ) INTO checks;

  FOR check_entry IN SELECT key, value FROM jsonb_each_text(checks)
  LOOP
    IF check_entry.value::boolean IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'matriz RLS falhou para % em %: esperado %, encontrou %',
        role_name, check_entry.key, expected, check_entry.value;
    END IF;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION pg_temp.assert_project_visible(boolean, text)
  TO authenticated;

SELECT set_config('request.jwt.claims', '{"supabase_uid":"10000000-0000-0000-0000-000000000004"}', true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_project_visible(true, 'alias');
RESET ROLE;

SELECT set_config('request.jwt.claims', '{"supabase_uid":"10000000-0000-0000-0000-000000000002"}', true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_project_visible(true, 'coordenador');
RESET ROLE;

SELECT set_config('request.jwt.claims', '{"supabase_uid":"10000000-0000-0000-0000-000000000001"}', true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_project_visible(true, 'criador sem membership');
RESET ROLE;

SELECT set_config('request.jwt.claims', '{"supabase_uid":"10000000-0000-0000-0000-000000000006"}', true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_project_visible(true, 'master');
RESET ROLE;

SELECT set_config('request.jwt.claims', '{"supabase_uid":"10000000-0000-0000-0000-000000000007"}', true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_project_visible(false, 'outsider');
RESET ROLE;

-- ========== Assignments: escopo e allowlist do pesquisador ==========

SELECT set_config('request.jwt.claims', '{"supabase_uid":"10000000-0000-0000-0000-000000000004"}', true);
SET LOCAL ROLE authenticated;

UPDATE public.assignments
SET status = 'concluido', completed_at = now()
WHERE id = '40000000-0000-0000-0000-000000000001';

SELECT pg_temp.assert_rejected($sql$
  UPDATE public.assignments
  SET type = 'comparacao'
  WHERE id = '40000000-0000-0000-0000-000000000001'
$sql$, 'assignment researcher structural UPDATE');

RESET ROLE;

SELECT set_config('request.jwt.claims', '{"supabase_uid":"10000000-0000-0000-0000-000000000002"}', true);
SET LOCAL ROLE authenticated;

INSERT INTO public.assignments (
  id, project_id, document_id, user_id, status, type, batch_id
) VALUES (
  '40000000-0000-0000-0000-000000000002',
  '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000005', 'pendente', 'comparacao',
  '35000000-0000-0000-0000-000000000001'
);

SELECT pg_temp.assert_rejected($sql$
  UPDATE public.assignments
  SET user_id = '10000000-0000-0000-0000-000000000003'
  WHERE id = '40000000-0000-0000-0000-000000000002'
$sql$, 'assignment administrative identity UPDATE');

SELECT pg_temp.assert_rejected($sql$
  INSERT INTO public.assignments (
    project_id, document_id, user_id, status, type
  ) VALUES (
    '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000003',
    '10000000-0000-0000-0000-000000000005', 'pendente', 'comparacao'
  )
$sql$, 'assignment document cross-project');

SELECT pg_temp.assert_rejected($sql$
  INSERT INTO public.assignments (
    project_id, document_id, user_id, status, type, batch_id
  ) VALUES (
    '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000005', 'pendente', 'comparacao',
    '35000000-0000-0000-0000-000000000002'
  )
$sql$, 'assignment batch cross-project');

SELECT pg_temp.assert_rejected($sql$
  INSERT INTO public.assignments (
    project_id, document_id, user_id, status, type
  ) VALUES (
    '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000007', 'pendente', 'comparacao'
  )
$sql$, 'assignment non-member target');

RESET ROLE;

-- ========== Comentários e exclusion_pending ==========

SELECT set_config('request.jwt.claims', '{"supabase_uid":"10000000-0000-0000-0000-000000000004"}', true);
SET LOCAL ROLE authenticated;

INSERT INTO public.project_comments (
  id, project_id, document_id, author_id, body, kind
) VALUES (
  '34000000-0000-0000-0000-000000000002',
  '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000004',
  'Fora do escopo', 'exclusion_request'
);

SELECT pg_temp.assert_rejected($sql$
  INSERT INTO public.project_comments (
    project_id, document_id, author_id, body, kind
  ) VALUES (
    '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000003',
    '10000000-0000-0000-0000-000000000004',
    'Ataque cross-project', 'exclusion_request'
  )
$sql$, 'project_comments INSERT cross-project');

SELECT pg_temp.assert_rejected($sql$
  INSERT INTO public.project_comments (
    project_id, document_id, author_id, body, parent_id
  ) VALUES (
    '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000004',
    'Parent cross-project',
    '34000000-0000-0000-0000-000000000003'
  )
$sql$, 'project_comments parent cross-project');

DO $$
BEGIN
  IF (SELECT exclusion_pending_at IS NULL FROM public.documents WHERE id = '30000000-0000-0000-0000-000000000001') THEN
    RAISE EXCEPTION 'pedido válido não marcou exclusion_pending_at';
  END IF;
END;
$$;

SELECT pg_temp.assert_rejected($sql$
  UPDATE public.project_comments
  SET document_id = '30000000-0000-0000-0000-000000000002'
  WHERE id = '34000000-0000-0000-0000-000000000002'
$sql$, 'authenticated project_comments structural UPDATE');

RESET ROLE;

-- A manutenção administrativa continua podendo mover a linha. O trigger
-- derivado precisa limpar o documento antigo e preencher o novo em ambos os
-- lados do UPDATE.
SELECT set_config('request.jwt.claims', '{}', true);
UPDATE public.project_comments
SET document_id = '30000000-0000-0000-0000-000000000002'
WHERE id = '34000000-0000-0000-0000-000000000002';

DO $$
BEGIN
  IF NOT (SELECT exclusion_pending_at IS NULL FROM public.documents WHERE id = '30000000-0000-0000-0000-000000000001')
     OR (SELECT exclusion_pending_at IS NULL FROM public.documents WHERE id = '30000000-0000-0000-0000-000000000002') THEN
    RAISE EXCEPTION 'trigger não reconciliou OLD/NEW document_id';
  END IF;
END;
$$;

SELECT set_config('request.jwt.claims', '{"supabase_uid":"10000000-0000-0000-0000-000000000004"}', true);
SET LOCAL ROLE authenticated;

SELECT pg_temp.assert_rejected($sql$
  UPDATE public.project_comments
  SET document_id = '30000000-0000-0000-0000-000000000003'
  WHERE id = '34000000-0000-0000-0000-000000000002'
$sql$, 'project_comments UPDATE cross-project');

RESET ROLE;

DO $$
BEGIN
  IF (SELECT exclusion_pending_at IS NULL FROM public.documents WHERE id = '30000000-0000-0000-0000-000000000002')
     OR NOT (SELECT exclusion_pending_at IS NULL FROM public.documents WHERE id = '30000000-0000-0000-0000-000000000003')
     OR EXISTS (
       SELECT 1 FROM public.project_comments WHERE body = 'Ataque cross-project'
     ) THEN
    RAISE EXCEPTION 'ataque cross-project alterou comentário ou estado derivado de exclusão';
  END IF;
END;
$$;

-- ========== Responses e reviews por alias ==========

SELECT set_config('request.jwt.claims', '{"supabase_uid":"10000000-0000-0000-0000-000000000004"}', true);
SET LOCAL ROLE authenticated;

INSERT INTO public.responses (
  id, project_id, document_id, respondent_id, respondent_type, respondent_name,
  answers, is_latest, pydantic_hash, schema_version_major,
  schema_version_minor, schema_version_patch, version_inferred_from, round_id,
  answer_field_hashes, created_at, updated_at
) VALUES (
  '50000000-0000-0000-0000-000000000004',
  '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000003',
  'humano', 'Nome forjado pelo caller', '{"campo":"valor"}', true,
  'schema-a', 1, 2, 3, 'live_save',
  '31000000-0000-0000-0000-000000000001', '{"campo":"hash-campo"}',
  '2000-01-01 00:00:00+00', '2000-01-01 00:00:00+00'
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.responses
    WHERE id = '50000000-0000-0000-0000-000000000004'
      AND respondent_name = 'member-rls@example.test'
      AND created_at > transaction_timestamp() - interval '1 minute'
      AND updated_at > transaction_timestamp() - interval '1 minute'
  ) THEN
    RAISE EXCEPTION 'response não canonizou nome e timestamps do INSERT';
  END IF;
END;
$$;

UPDATE public.responses
SET answers = '{"campo":"novo valor"}', updated_at = now()
WHERE id = '50000000-0000-0000-0000-000000000004';

SELECT pg_temp.assert_rejected($sql$
  UPDATE public.responses
  SET respondent_name = 'nome forjado'
  WHERE id = '50000000-0000-0000-0000-000000000004'
$sql$, 'response structural UPDATE');

SELECT pg_temp.assert_rejected($sql$
  UPDATE public.responses
  SET pydantic_hash = 'forjado'
  WHERE id = '50000000-0000-0000-0000-000000000004'
$sql$, 'response schema metadata UPDATE');

SELECT pg_temp.assert_rejected($sql$
  UPDATE public.responses
  SET answer_field_hashes = '{"campo":"hash-forjado"}'
  WHERE id = '50000000-0000-0000-0000-000000000004'
$sql$, 'response answer_field_hashes UPDATE');

-- O UPDATE direto continua fail-closed. A #216 deverá testar sua futura RPC
-- atômica separadamente, inclusive optimistic concurrency e preservação dos
-- hashes stale de campos não tocados.
SELECT pg_temp.assert_rejected($sql$
  UPDATE public.responses
  SET answer_field_hashes = '{}'
  WHERE id = '50000000-0000-0000-0000-000000000004'
$sql$, 'response incomplete answer_field_hashes UPDATE');

SELECT pg_temp.assert_rejected($sql$
  UPDATE public.responses
  SET created_at = '2000-01-01 00:00:00+00'
  WHERE id = '50000000-0000-0000-0000-000000000004'
$sql$, 'response created_at UPDATE');

SELECT pg_temp.assert_rejected($sql$
  UPDATE public.responses
  SET round_id = NULL
  WHERE id = '50000000-0000-0000-0000-000000000004'
$sql$, 'response round UPDATE');

SELECT pg_temp.assert_rejected($sql$
  INSERT INTO public.responses (
    project_id, document_id, respondent_id, respondent_type, answers,
    is_latest, pydantic_hash, schema_version_major, schema_version_minor,
    schema_version_patch, version_inferred_from, round_id,
    answer_field_hashes
  ) VALUES (
    '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000003',
    '10000000-0000-0000-0000-000000000003', 'humano', '{}', true,
    'schema-a', 1, 2, 3, 'live_save',
    '31000000-0000-0000-0000-000000000001', '{"campo":"hash-campo"}'
  )
$sql$, 'response document cross-project');

SELECT pg_temp.assert_rejected($sql$
  INSERT INTO public.responses (
    project_id, document_id, respondent_id, respondent_type, answers,
    is_latest, pydantic_hash, schema_version_major, schema_version_minor,
    schema_version_patch, version_inferred_from, round_id,
    answer_field_hashes
  ) VALUES (
    '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000007', 'humano', '{}', true,
    'schema-a', 1, 2, 3, 'live_save',
    '31000000-0000-0000-0000-000000000001', '{"campo":"hash-campo"}'
  )
$sql$, 'response respondent identity');

SELECT pg_temp.assert_rejected($sql$
  INSERT INTO public.responses (
    project_id, document_id, respondent_type, respondent_name, answers,
    is_latest, pydantic_hash, llm_job_id
  ) VALUES (
    '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000002', 'llm', 'LLM forjada', '{}',
    true, 'schema-a', '33000000-0000-0000-0000-000000000001'
  )
$sql$, 'authenticated LLM response');

INSERT INTO public.reviews (
  id, project_id, document_id, field_name, reviewer_id, verdict,
  chosen_response_id, response_snapshot, created_at
) VALUES (
  '70000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001', 'campo',
  '10000000-0000-0000-0000-000000000003', 'concordo',
  '50000000-0000-0000-0000-000000000002',
  '[{"id":"50000000-0000-0000-0000-000000000001","respondent_name":"Membro","respondent_type":"humano","answer":"humano"},{"id":"50000000-0000-0000-0000-000000000002","respondent_name":"LLM","respondent_type":"llm","answer":"llm"}]',
  '2000-01-01 00:00:00+00'
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.reviews
    WHERE id = '70000000-0000-0000-0000-000000000001'
      AND created_at > transaction_timestamp() - interval '1 minute'
  ) THEN
    RAISE EXCEPTION 'review não canonizou created_at';
  END IF;
END;
$$;

UPDATE public.reviews
SET comment = 'decisão revisada', resolved_at = now(),
    resolved_by = '10000000-0000-0000-0000-000000000003'
WHERE id = '70000000-0000-0000-0000-000000000001';

SELECT pg_temp.assert_rejected($sql$
  UPDATE public.reviews
  SET reviewer_id = '10000000-0000-0000-0000-000000000004'
  WHERE id = '70000000-0000-0000-0000-000000000001'
$sql$, 'review reviewer_id UPDATE');

SELECT pg_temp.assert_rejected($sql$
  UPDATE public.reviews
  SET resolved_by = '10000000-0000-0000-0000-000000000007'
  WHERE id = '70000000-0000-0000-0000-000000000001'
$sql$, 'review resolved_by impersonation');

SELECT pg_temp.assert_rejected($sql$
  UPDATE public.reviews
  SET chosen_response_id = '50000000-0000-0000-0000-000000000003'
  WHERE id = '70000000-0000-0000-0000-000000000001'
$sql$, 'review chosen_response cross-project');

SELECT pg_temp.assert_rejected($sql$
  UPDATE public.reviews
  SET response_snapshot = '[{"id":"50000000-0000-0000-0000-000000000001","respondent_name":"Membro","respondent_type":"humano","answer":"forjada"}]'
  WHERE id = '70000000-0000-0000-0000-000000000001'
$sql$, 'review forged response_snapshot');

SELECT pg_temp.assert_rejected($sql$
  INSERT INTO public.reviews (
    project_id, document_id, field_name, reviewer_id, verdict,
    resolved_at, resolved_by
  ) VALUES (
    '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000002', 'campo',
    '10000000-0000-0000-0000-000000000003', 'concordo', now(),
    '10000000-0000-0000-0000-000000000003'
  )
$sql$, 'review forged resolution metadata on INSERT');

INSERT INTO public.response_equivalences (
  id, project_id, document_id, field_name, response_a_id, response_b_id,
  reviewer_id, created_at
) VALUES (
  '71000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001', 'campo',
  '50000000-0000-0000-0000-000000000001',
  '50000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000003',
  '2000-01-01 00:00:00+00'
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.response_equivalences
    WHERE id = '71000000-0000-0000-0000-000000000001'
      AND created_at > transaction_timestamp() - interval '1 minute'
  ) THEN
    RAISE EXCEPTION 'response_equivalence não canonizou created_at';
  END IF;
END;
$$;

SELECT pg_temp.assert_rejected($sql$
  INSERT INTO public.response_equivalences (
    project_id, document_id, field_name, response_a_id, response_b_id,
    reviewer_id
  ) VALUES (
    '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001', 'campo',
    '50000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000003',
    '10000000-0000-0000-0000-000000000003'
  )
$sql$, 'response_equivalence response cross-project');

SELECT pg_temp.assert_rejected($sql$
  INSERT INTO public.response_equivalences (
    project_id, document_id, field_name, response_a_id, response_b_id,
    reviewer_id
  ) VALUES (
    '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000003', 'campo',
    '50000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000003'
  )
$sql$, 'response_equivalence document cross-project');

SELECT pg_temp.assert_rejected($sql$
  INSERT INTO public.response_equivalences (
    project_id, document_id, field_name, response_a_id, response_b_id,
    reviewer_id
  ) VALUES (
    '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001', 'campo',
    '50000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000007'
  )
$sql$, 'response_equivalence reviewer impersonation');

SELECT pg_temp.assert_rejected($sql$
  UPDATE public.response_equivalences
  SET field_name = 'campo-inexistente'
  WHERE id = '71000000-0000-0000-0000-000000000001'
$sql$, 'response_equivalence field outside schema');

INSERT INTO public.schema_suggestions (
  id, project_id, field_name, suggested_by, suggested_changes, reason,
  created_at
) VALUES (
  '72000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001', 'campo',
  '10000000-0000-0000-0000-000000000004',
  '{"description":"nova"}', 'motivo', '2000-01-01 00:00:00+00'
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.schema_suggestions
    WHERE id = '72000000-0000-0000-0000-000000000001'
      AND status = 'pending'
      AND created_at > transaction_timestamp() - interval '1 minute'
  ) THEN
    RAISE EXCEPTION 'schema_suggestion não canonizou estado/timestamp';
  END IF;
END;
$$;

SELECT pg_temp.assert_rejected($sql$
  INSERT INTO public.schema_suggestions (
    project_id, field_name, suggested_by, suggested_changes, status,
    resolved_by, resolved_at
  ) VALUES (
    '20000000-0000-0000-0000-000000000001', 'campo',
    '10000000-0000-0000-0000-000000000004', '{}', 'approved',
    '10000000-0000-0000-0000-000000000004', now()
  )
$sql$, 'schema_suggestion forged resolution on INSERT');

SELECT pg_temp.assert_rejected($sql$
  INSERT INTO public.schema_suggestions (
    project_id, field_name, suggested_by, suggested_changes
  ) VALUES (
    '20000000-0000-0000-0000-000000000001', 'campo-inexistente',
    '10000000-0000-0000-0000-000000000004', '{}'
  )
$sql$, 'schema_suggestion field outside schema');

INSERT INTO public.verdict_acknowledgments (
  id, review_id, respondent_id, status, comment, created_at
) VALUES (
  '73000000-0000-0000-0000-000000000001',
  '70000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000004', 'accepted', 'ciente',
  '2000-01-01 00:00:00+00'
);

UPDATE public.verdict_acknowledgments
SET status = 'questioned', comment = 'dúvida'
WHERE id = '73000000-0000-0000-0000-000000000001';

SELECT pg_temp.assert_rejected($sql$
  UPDATE public.verdict_acknowledgments
  SET respondent_id = '10000000-0000-0000-0000-000000000003'
  WHERE id = '73000000-0000-0000-0000-000000000001'
$sql$, 'acknowledgment respondent identity UPDATE');

INSERT INTO public.reviews (
  id, project_id, document_id, field_name, reviewer_id, verdict
) VALUES (
  '70000000-0000-0000-0000-000000000002',
  '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000002', 'campo',
  '10000000-0000-0000-0000-000000000003', 'concordo'
);

SELECT pg_temp.assert_rejected($sql$
  INSERT INTO public.verdict_acknowledgments (
    review_id, respondent_id, status, resolved_by, resolved_at
  ) VALUES (
    '70000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000004', 'accepted',
    '10000000-0000-0000-0000-000000000004', now()
  )
$sql$, 'acknowledgment forged resolution on INSERT');

RESET ROLE;

-- response_snapshot é fotografia histórica. Uma response pode mudar depois
-- do veredito; resolver o review sem trocar o snapshot não deve reinterpretar
-- a fotografia antiga contra o estado atual.
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL ROLE service_role;
UPDATE public.responses
SET answers = '{"campo":"humano alterado depois do veredito"}'
WHERE id = '50000000-0000-0000-0000-000000000001';
RESET ROLE;

-- Coordenador pode resolver review alheio, mas não fabricar autoria alheia.
SELECT set_config('request.jwt.claims', '{"supabase_uid":"10000000-0000-0000-0000-000000000002"}', true);
SET LOCAL ROLE authenticated;

UPDATE public.reviews
SET resolved_at = now(), resolved_by = '10000000-0000-0000-0000-000000000002'
WHERE id = '70000000-0000-0000-0000-000000000001';

UPDATE public.response_equivalences
SET field_name = 'campo'
WHERE id = '71000000-0000-0000-0000-000000000001';

UPDATE public.field_reviews
SET arbitrator_comment = 'administração do coordenador'
WHERE id = '60000000-0000-0000-0000-000000000001';

INSERT INTO public.assignment_batches (
  id, project_id, created_by, created_at, label
) VALUES (
  '35000000-0000-0000-0000-000000000003',
  '20000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000002',
  '2000-01-01 00:00:00+00', 'Lote coordenador'
);

SELECT pg_temp.assert_rejected($sql$
  INSERT INTO public.assignment_batches (
    project_id, created_by, label
  ) VALUES (
    '20000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000003', 'created_by forjado'
  )
$sql$, 'assignment_batch creator impersonation');

SELECT pg_temp.assert_rejected($sql$
  UPDATE public.assignment_batches
  SET created_by = '10000000-0000-0000-0000-000000000003'
  WHERE id = '35000000-0000-0000-0000-000000000003'
$sql$, 'assignment_batch structural UPDATE');

INSERT INTO public.difficulty_resolutions (
  id, project_id, response_id, document_id, resolved_by, resolved_at
) VALUES (
  '74000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  '50000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000007', '2000-01-01 00:00:00+00'
);

INSERT INTO public.error_resolutions (
  id, project_id, document_id, field_name, resolved_by, resolved_at
) VALUES (
  '74000000-0000-0000-0000-000000000002',
  '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001', 'campo',
  '10000000-0000-0000-0000-000000000007', '2000-01-01 00:00:00+00'
);

INSERT INTO public.note_resolutions (
  id, project_id, response_id, resolved_by, resolved_at
) VALUES (
  '74000000-0000-0000-0000-000000000003',
  '20000000-0000-0000-0000-000000000001',
  '50000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000007', '2000-01-01 00:00:00+00'
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT resolved_by, resolved_at FROM public.difficulty_resolutions
      WHERE id = '74000000-0000-0000-0000-000000000001'
      UNION ALL
      SELECT resolved_by, resolved_at FROM public.error_resolutions
      WHERE id = '74000000-0000-0000-0000-000000000002'
      UNION ALL
      SELECT resolved_by, resolved_at FROM public.note_resolutions
      WHERE id = '74000000-0000-0000-0000-000000000003'
    ) AS resolution
    WHERE resolution.resolved_by IS DISTINCT FROM
          '10000000-0000-0000-0000-000000000002'::uuid
       OR resolution.resolved_at <= transaction_timestamp() - interval '1 minute'
  ) THEN
    RAISE EXCEPTION 'resolution não canonizou ator/timestamp';
  END IF;
END;
$$;

SELECT pg_temp.assert_rejected($sql$
  INSERT INTO public.difficulty_resolutions (
    project_id, response_id, document_id, resolved_by
  ) VALUES (
    '20000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000003',
    '30000000-0000-0000-0000-000000000003',
    '10000000-0000-0000-0000-000000000002'
  )
$sql$, 'difficulty_resolution cross-project');

SELECT pg_temp.assert_rejected($sql$
  INSERT INTO public.error_resolutions (
    project_id, document_id, field_name, resolved_by
  ) VALUES (
    '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000003', 'cross-project',
    '10000000-0000-0000-0000-000000000002'
  )
$sql$, 'error_resolution cross-project');

SELECT pg_temp.assert_rejected($sql$
  INSERT INTO public.note_resolutions (
    project_id, response_id, resolved_by
  ) VALUES (
    '20000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000003',
    '10000000-0000-0000-0000-000000000002'
  )
$sql$, 'note_resolution cross-project');

UPDATE public.schema_suggestions
SET status = 'approved',
    resolved_by = '10000000-0000-0000-0000-000000000002',
    resolved_at = '2000-01-01 00:00:00+00'
WHERE id = '72000000-0000-0000-0000-000000000001';

SELECT pg_temp.assert_rejected($sql$
  UPDATE public.schema_suggestions
  SET suggested_changes = '{"description":"forjada"}'
  WHERE id = '72000000-0000-0000-0000-000000000001'
$sql$, 'schema_suggestion structural UPDATE');

UPDATE public.verdict_acknowledgments
SET resolved_at = '2000-01-01 00:00:00+00',
    resolved_by = '10000000-0000-0000-0000-000000000002'
WHERE id = '73000000-0000-0000-0000-000000000001';

SELECT pg_temp.assert_rejected($sql$
  UPDATE public.verdict_acknowledgments
  SET resolved_by = '10000000-0000-0000-0000-000000000007'
  WHERE id = '73000000-0000-0000-0000-000000000001'
$sql$, 'acknowledgment resolved_by impersonation');

SELECT pg_temp.assert_rejected($sql$
  INSERT INTO public.reviews (
    project_id, document_id, field_name, reviewer_id, verdict
  ) VALUES (
    '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001', 'forjado',
    '10000000-0000-0000-0000-000000000003', 'concordo'
  )
$sql$, 'coordinator review impersonation');

SELECT pg_temp.assert_rejected($sql$
  INSERT INTO public.response_equivalences (
    project_id, document_id, field_name, response_a_id, response_b_id,
    reviewer_id
  ) VALUES (
    '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001', 'campo',
    '50000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000003'
  )
$sql$, 'coordinator response_equivalence impersonation');

SELECT pg_temp.assert_rejected($sql$
  INSERT INTO public.field_reviews (
    project_id, document_id, field_name, human_response_id, llm_response_id,
    self_reviewer_id
  ) VALUES (
    '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001', 'coord-insert',
    '50000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000003'
  )
$sql$, 'coordinator field_review INSERT');

RESET ROLE;

-- Criador sem membership e master preservam UPDATE administrativo, mas não
-- ganham um caminho autenticado de criação da fila.
SELECT set_config('request.jwt.claims', '{"supabase_uid":"10000000-0000-0000-0000-000000000001"}', true);
SET LOCAL ROLE authenticated;

UPDATE public.response_equivalences
SET field_name = 'campo'
WHERE id = '71000000-0000-0000-0000-000000000001';

UPDATE public.field_reviews
SET arbitrator_comment = 'administração do criador'
WHERE id = '60000000-0000-0000-0000-000000000001';

SELECT pg_temp.assert_rejected($sql$
  INSERT INTO public.field_reviews (
    project_id, document_id, field_name, human_response_id, llm_response_id,
    self_reviewer_id
  ) VALUES (
    '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001', 'creator-insert',
    '50000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000003'
  )
$sql$, 'creator field_review INSERT');

RESET ROLE;

SELECT set_config('request.jwt.claims', '{"supabase_uid":"10000000-0000-0000-0000-000000000006"}', true);
SET LOCAL ROLE authenticated;

UPDATE public.response_equivalences
SET field_name = 'campo'
WHERE id = '71000000-0000-0000-0000-000000000001';

UPDATE public.field_reviews
SET arbitrator_comment = 'administração do master'
WHERE id = '60000000-0000-0000-0000-000000000001';

SELECT pg_temp.assert_rejected($sql$
  INSERT INTO public.field_reviews (
    project_id, document_id, field_name, human_response_id, llm_response_id,
    self_reviewer_id
  ) VALUES (
    '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001', 'master-insert',
    '50000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000003'
  )
$sql$, 'master field_review INSERT');

RESET ROLE;

SELECT set_config('request.jwt.claims', '{"supabase_uid":"10000000-0000-0000-0000-000000000007"}', true);
SET LOCAL ROLE authenticated;

SELECT pg_temp.assert_rejected($sql$
  INSERT INTO public.project_comments (
    project_id, document_id, author_id, body
  ) VALUES (
    '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000007', 'outsider'
  )
$sql$, 'outsider project_comment INSERT');

SELECT pg_temp.assert_rejected($sql$
  INSERT INTO public.field_reviews (
    project_id, document_id, field_name, human_response_id, llm_response_id,
    self_reviewer_id
  ) VALUES (
    '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001', 'outsider-insert',
    '50000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000003'
  )
$sql$, 'outsider field_review INSERT');

SELECT pg_temp.assert_rejected($sql$
  INSERT INTO public.response_equivalences (
    project_id, document_id, field_name, response_a_id, response_b_id,
    reviewer_id
  ) VALUES (
    '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001', 'campo',
    '50000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000007'
  )
$sql$, 'outsider response_equivalence INSERT');

RESET ROLE;

-- ========== Field reviews: allowlists separadas ==========

SELECT set_config('request.jwt.claims', '{"supabase_uid":"10000000-0000-0000-0000-000000000004"}', true);
SET LOCAL ROLE authenticated;

UPDATE public.field_reviews
SET self_verdict = 'contesta_llm', self_reviewed_at = now(),
    self_justification = 'discordo'
WHERE id = '60000000-0000-0000-0000-000000000001';

SELECT pg_temp.assert_rejected($sql$
  UPDATE public.field_reviews
  SET blind_verdict = 'humano', blind_decided_at = now()
  WHERE id = '60000000-0000-0000-0000-000000000001'
$sql$, 'self reviewer changed arbitrator phase');

SELECT pg_temp.assert_rejected($sql$
  INSERT INTO public.field_reviews (
    project_id, document_id, field_name, human_response_id, llm_response_id,
    self_reviewer_id
  ) VALUES (
    '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001', 'fabricado',
    '50000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000003'
  )
$sql$, 'authenticated field_review INSERT');

RESET ROLE;

SELECT set_config('request.jwt.claims', '{"supabase_uid":"10000000-0000-0000-0000-000000000005"}', true);
SET LOCAL ROLE authenticated;

UPDATE public.field_reviews
SET blind_verdict = 'humano', blind_decided_at = now()
WHERE id = '60000000-0000-0000-0000-000000000001';

SELECT pg_temp.assert_rejected($sql$
  UPDATE public.field_reviews
  SET self_justification = 'forjada pelo árbitro'
  WHERE id = '60000000-0000-0000-0000-000000000001'
$sql$, 'arbitrator changed self-review phase');

RESET ROLE;

-- ========== Service role: triggers executam sem EXECUTE RPC ==========

SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL ROLE service_role;

INSERT INTO public.responses (
  id, project_id, document_id, respondent_type, respondent_name, answers,
  is_latest, pydantic_hash, llm_job_id
) VALUES (
  '50000000-0000-0000-0000-000000000005',
  '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000002', 'llm', 'LLM service', '{}', true,
  'schema-a', '33000000-0000-0000-0000-000000000001'
);

INSERT INTO public.field_reviews (
  id, project_id, document_id, field_name, human_response_id, llm_response_id,
  self_reviewer_id, arbitrator_id
) VALUES (
  '60000000-0000-0000-0000-000000000002',
  '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000002', 'campo',
  '50000000-0000-0000-0000-000000000004',
  '50000000-0000-0000-0000-000000000005',
  '10000000-0000-0000-0000-000000000003',
  '10000000-0000-0000-0000-000000000005'
);

SELECT pg_temp.assert_rejected($sql$
  INSERT INTO public.responses (
    project_id, document_id, respondent_type, respondent_name, answers, is_latest
  ) VALUES (
    '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000003', 'llm', 'LLM cross-project', '{}', true
  )
$sql$, 'service_role response cross-project');

SELECT pg_temp.assert_rejected($sql$
  INSERT INTO public.field_reviews (
    project_id, document_id, field_name, human_response_id, llm_response_id,
    self_reviewer_id
  ) VALUES (
    '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000003', 'cross-project',
    '50000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000003'
  )
$sql$, 'service_role field_review cross-project');

RESET ROLE;

-- A posse de uma linha antiga não conserva acesso após remover o membro.
DELETE FROM public.member_email_links
WHERE id = '21000000-0000-0000-0000-000000000001';
DELETE FROM public.project_members
WHERE project_id = '20000000-0000-0000-0000-000000000001'
  AND user_id = '10000000-0000-0000-0000-000000000003';

SELECT set_config('request.jwt.claims', '{"supabase_uid":"10000000-0000-0000-0000-000000000004"}', true);
SET LOCAL ROLE authenticated;

SELECT pg_temp.assert_project_visible(false, 'alias de ex-membro');

DO $$
DECLARE
  changed integer;
BEGIN
  WITH updated AS (
    UPDATE public.responses
    SET answers = '{"campo":"sem acesso"}'
    WHERE id = '50000000-0000-0000-0000-000000000004'
    RETURNING 1
  )
  SELECT count(*) INTO changed FROM updated;

  IF changed <> 0 THEN
    RAISE EXCEPTION 'alias revogado ainda atualizou response';
  END IF;
END;
$$;

RESET ROLE;

SELECT set_config('request.jwt.claims', '{"supabase_uid":"10000000-0000-0000-0000-000000000003"}', true);
SET LOCAL ROLE authenticated;

SELECT pg_temp.assert_project_visible(false, 'ex-membro direto');

DO $$
DECLARE
  changed integer;
BEGIN
  WITH updated AS (
    UPDATE public.responses
    SET answers = '{"campo":"sem acesso direto"}'
    WHERE id = '50000000-0000-0000-0000-000000000004'
    RETURNING 1
  )
  SELECT count(*) INTO changed FROM updated;

  IF changed <> 0 THEN
    RAISE EXCEPTION 'ex-membro direto ainda atualizou response';
  END IF;
END;
$$;

RESET ROLE;

DO $$
BEGIN
  RAISE NOTICE 'OK matriz: papéis, aliases, ex-membros, metadata, escopo, fases e service_role';
END;
$$;

ROLLBACK;
