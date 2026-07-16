-- Contrato de autoria das responses: toda sessão JWT grava somente sua
-- resposta humana; o backend privilegiado grava o braço LLM sem respondent_id.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

SELECT plan(10);

CREATE OR REPLACE FUNCTION pg_temp.rejected_sqlstate(statement TEXT)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  actual_sqlstate TEXT;
BEGIN
  EXECUTE statement;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS actual_sqlstate = RETURNED_SQLSTATE;
  RETURN actual_sqlstate;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.rejected_constraint(statement TEXT)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  actual_constraint TEXT;
BEGIN
  EXECUTE statement;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS actual_constraint = CONSTRAINT_NAME;
  RETURN actual_constraint;
END;
$$;

-- O trigger de auth cria automaticamente os profiles correspondentes.
INSERT INTO auth.users (id, email) VALUES
  ('48310000-0000-0000-0000-000000000001', 'coordinator-483@example.test'),
  ('48310000-0000-0000-0000-000000000002', 'researcher-483@example.test'),
  ('48310000-0000-0000-0000-000000000003', 'creator-483@example.test'),
  ('48310000-0000-0000-0000-000000000004', 'master-483@example.test'),
  ('48310000-0000-0000-0000-000000000005', 'outsider-483@example.test'),
  ('48310000-0000-0000-0000-000000000006', 'alias-483@example.test');

INSERT INTO public.clerk_user_mapping
  (clerk_user_id, supabase_user_id, access_sync_version)
SELECT id::TEXT, id, 1
FROM auth.users
WHERE id::TEXT LIKE '48310000-0000-0000-0000-%';

INSERT INTO public.projects (id, name, created_by) VALUES (
  '48320000-0000-0000-0000-000000000001',
  'responses actor integrity',
  '48310000-0000-0000-0000-000000000003'
);

INSERT INTO public.project_members (project_id, user_id, role) VALUES
  (
    '48320000-0000-0000-0000-000000000001',
    '48310000-0000-0000-0000-000000000001',
    'coordenador'
  ),
  (
    '48320000-0000-0000-0000-000000000001',
    '48310000-0000-0000-0000-000000000002',
    'pesquisador'
  );

INSERT INTO public.master_users (user_id) VALUES
  ('48310000-0000-0000-0000-000000000004');

INSERT INTO public.member_email_links (
  project_id,
  member_user_id,
  email,
  linked_user_id,
  created_by
) VALUES (
  '48320000-0000-0000-0000-000000000001',
  '48310000-0000-0000-0000-000000000002',
  'alias-483@example.test',
  '48310000-0000-0000-0000-000000000006',
  '48310000-0000-0000-0000-000000000003'
);

INSERT INTO public.documents (id, project_id, title, text, text_hash) VALUES
  (
    '48330000-0000-0000-0000-000000000001',
    '48320000-0000-0000-0000-000000000001',
    'backend llm', 'texto', 'hash-483-1'
  ),
  (
    '48330000-0000-0000-0000-000000000002',
    '48320000-0000-0000-0000-000000000001',
    'human response', 'texto', 'hash-483-2'
  ),
  (
    '48330000-0000-0000-0000-000000000003',
    '48320000-0000-0000-0000-000000000001',
    'alias response', 'texto', 'hash-483-3'
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.responses TO authenticated;

SELECT lives_ok(
  $sql$
    INSERT INTO public.responses (
      project_id, document_id, respondent_type, respondent_name, answers
    ) VALUES (
      '48320000-0000-0000-0000-000000000001',
      '48330000-0000-0000-0000-000000000001',
      'llm', 'openai/gpt-5', '{"q1":"backend"}'
    )
  $sql$,
  'backend privilegiado grava LLM sem respondent_id'
);

SELECT is(
  pg_temp.rejected_constraint(
    $sql$
      INSERT INTO public.responses (
        project_id, document_id, respondent_id, respondent_type, answers
      ) VALUES (
        '48320000-0000-0000-0000-000000000001',
        '48330000-0000-0000-0000-000000000001',
        '48310000-0000-0000-0000-000000000002',
        'llm', '{"q1":"forjado"}'
      )
    $sql$
  ),
  'responses_llm_has_no_human_actor_check',
  'constraint nomeada rejeita LLM com ator humano até em escrita privilegiada'
);

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"48310000-0000-0000-0000-000000000002","supabase_uid":"48310000-0000-0000-0000-000000000002"}',
  true
);
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $sql$
    INSERT INTO public.responses (
      id, project_id, document_id, respondent_id, respondent_type, answers
    ) VALUES (
      '48340000-0000-0000-0000-000000000001',
      '48320000-0000-0000-0000-000000000001',
      '48330000-0000-0000-0000-000000000002',
      '48310000-0000-0000-0000-000000000002',
      'humano', '{"q1":"legitimo"}'
    )
  $sql$,
  'pesquisador grava a própria resposta humana'
);
SELECT is(
  pg_temp.rejected_sqlstate(
    $sql$
      INSERT INTO public.responses (
        project_id, document_id, respondent_type, answers
      ) VALUES (
        '48320000-0000-0000-0000-000000000001',
        '48330000-0000-0000-0000-000000000001',
        'llm', '{"q1":"forjado"}'
      )
    $sql$
  ),
  '42501',
  'pesquisador não grava resposta LLM anônima'
);
RESET ROLE;

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"48310000-0000-0000-0000-000000000001","supabase_uid":"48310000-0000-0000-0000-000000000001"}',
  true
);
SET LOCAL ROLE authenticated;
SELECT is(
  pg_temp.rejected_sqlstate(
    $sql$
      INSERT INTO public.responses (
        project_id, document_id, respondent_type, answers
      ) VALUES (
        '48320000-0000-0000-0000-000000000001',
        '48330000-0000-0000-0000-000000000001',
        'llm', '{"q1":"coordenador"}'
      )
    $sql$
  ),
  '42501',
  'coordenador não grava resposta LLM'
);
RESET ROLE;

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"48310000-0000-0000-0000-000000000003","supabase_uid":"48310000-0000-0000-0000-000000000003"}',
  true
);
SET LOCAL ROLE authenticated;
SELECT is(
  pg_temp.rejected_sqlstate(
    $sql$
      INSERT INTO public.responses (
        project_id, document_id, respondent_type, answers
      ) VALUES (
        '48320000-0000-0000-0000-000000000001',
        '48330000-0000-0000-0000-000000000001',
        'llm', '{"q1":"criador"}'
      )
    $sql$
  ),
  '42501',
  'criador não grava resposta LLM'
);
RESET ROLE;

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"48310000-0000-0000-0000-000000000004","supabase_uid":"48310000-0000-0000-0000-000000000004"}',
  true
);
SET LOCAL ROLE authenticated;
SELECT is(
  pg_temp.rejected_sqlstate(
    $sql$
      INSERT INTO public.responses (
        project_id, document_id, respondent_type, answers
      ) VALUES (
        '48320000-0000-0000-0000-000000000001',
        '48330000-0000-0000-0000-000000000001',
        'llm', '{"q1":"master"}'
      )
    $sql$
  ),
  '42501',
  'master não grava resposta LLM'
);
RESET ROLE;

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"48310000-0000-0000-0000-000000000005","supabase_uid":"48310000-0000-0000-0000-000000000005"}',
  true
);
SET LOCAL ROLE authenticated;
SELECT is(
  pg_temp.rejected_sqlstate(
    $sql$
      INSERT INTO public.responses (
        project_id, document_id, respondent_id, respondent_type, answers
      ) VALUES (
        '48320000-0000-0000-0000-000000000001',
        '48330000-0000-0000-0000-000000000002',
        '48310000-0000-0000-0000-000000000005',
        'humano', '{"q1":"outsider"}'
      )
    $sql$
  ),
  '42501',
  'outsider não grava resposta humana em projeto alheio'
);
RESET ROLE;

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"48310000-0000-0000-0000-000000000006","supabase_uid":"48310000-0000-0000-0000-000000000006"}',
  true
);
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $sql$
    INSERT INTO public.responses (
      project_id, document_id, respondent_id, respondent_type, answers
    ) VALUES (
      '48320000-0000-0000-0000-000000000001',
      '48330000-0000-0000-0000-000000000003',
      '48310000-0000-0000-0000-000000000002',
      'humano', '{"q1":"alias"}'
    )
  $sql$,
  'conta-alias grava com a identidade canônica do projeto'
);
RESET ROLE;

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"48310000-0000-0000-0000-000000000002","supabase_uid":"48310000-0000-0000-0000-000000000002"}',
  true
);
SET LOCAL ROLE authenticated;
SELECT is(
  pg_temp.rejected_sqlstate(
    $sql$
      UPDATE public.responses
      SET respondent_type = 'llm', respondent_id = NULL
      WHERE id = '48340000-0000-0000-0000-000000000001'
    $sql$
  ),
  '42501',
  'pesquisador não converte sua resposta humana em LLM anônima'
);
RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
