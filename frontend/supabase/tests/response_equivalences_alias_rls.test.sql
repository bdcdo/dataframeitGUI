-- Regressão da issue #427: identidade efetiva e limites de autorização das
-- equivalências precisam coincidir no código e na RLS.
--
-- Como rodar (após `npx supabase start` e `npx supabase db reset`):
--   psql "$(npx supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '\"')" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/response_equivalences_alias_rls.test.sql
--
-- A transação termina em ROLLBACK e não deixa fixtures no banco local.

BEGIN;

-- As inserções em auth.users disparam handle_new_user e criam os profiles que
-- sustentam as FKs usadas nas fixtures.
INSERT INTO auth.users (id, email) VALUES
  ('11111111-1111-1111-1111-111111111111', 'researcher-427@example.test'),
  ('22222222-2222-2222-2222-222222222222', 'researcher-alias-427@example.test'),
  ('77777777-7777-7777-7777-777777777777', 'coordinator-427@example.test'),
  ('88888888-8888-8888-8888-888888888888', 'coordinator-alias-427@example.test'),
  ('99999999-9999-9999-9999-999999999999', 'outsider-427@example.test'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'creator-427@example.test'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'master-427@example.test'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'arbitrary-427@example.test'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'project-b-owner-427@example.test');

INSERT INTO public.master_users (user_id) VALUES
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

INSERT INTO public.projects (id, name, created_by) VALUES
  (
    '33333333-3333-3333-3333-333333333333',
    'project A alias RLS #427',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  ),
  (
    '33333333-3333-3333-3333-333333333334',
    'project B isolation RLS #427',
    'dddddddd-dddd-dddd-dddd-dddddddddddd'
  );

INSERT INTO public.project_members (project_id, user_id, role) VALUES
  (
    '33333333-3333-3333-3333-333333333333',
    '11111111-1111-1111-1111-111111111111',
    'pesquisador'
  ),
  (
    '33333333-3333-3333-3333-333333333333',
    '77777777-7777-7777-7777-777777777777',
    'coordenador'
  );

INSERT INTO public.member_email_links
  (project_id, member_user_id, email, linked_user_id, created_by)
VALUES
  (
    '33333333-3333-3333-3333-333333333333',
    '11111111-1111-1111-1111-111111111111',
    'researcher-alias-427@example.test',
    '22222222-2222-2222-2222-222222222222',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  ),
  (
    '33333333-3333-3333-3333-333333333333',
    '77777777-7777-7777-7777-777777777777',
    'coordinator-alias-427@example.test',
    '88888888-8888-8888-8888-888888888888',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  );

INSERT INTO public.documents (id, project_id, title, text) VALUES
  (
    '44444444-4444-4444-4444-444444444444',
    '33333333-3333-3333-3333-333333333333',
    'document A alias RLS #427',
    'fixture A'
  ),
  (
    '44444444-4444-4444-4444-444444444445',
    '33333333-3333-3333-3333-333333333334',
    'document B isolation RLS #427',
    'fixture B'
  );

INSERT INTO public.responses
  (id, project_id, document_id, respondent_type, answers)
VALUES
  (
    '50000000-0000-0000-0000-000000000001',
    '33333333-3333-3333-3333-333333333333',
    '44444444-4444-4444-4444-444444444444',
    'llm',
    '{"question":"a1"}'
  ),
  (
    '50000000-0000-0000-0000-000000000002',
    '33333333-3333-3333-3333-333333333333',
    '44444444-4444-4444-4444-444444444444',
    'llm',
    '{"question":"a2"}'
  ),
  (
    '50000000-0000-0000-0000-000000000003',
    '33333333-3333-3333-3333-333333333333',
    '44444444-4444-4444-4444-444444444444',
    'llm',
    '{"question":"a3"}'
  ),
  (
    '50000000-0000-0000-0000-000000000004',
    '33333333-3333-3333-3333-333333333333',
    '44444444-4444-4444-4444-444444444444',
    'llm',
    '{"question":"a4"}'
  ),
  (
    '60000000-0000-0000-0000-000000000001',
    '33333333-3333-3333-3333-333333333334',
    '44444444-4444-4444-4444-444444444445',
    'llm',
    '{"question":"b1"}'
  ),
  (
    '60000000-0000-0000-0000-000000000002',
    '33333333-3333-3333-3333-333333333334',
    '44444444-4444-4444-4444-444444444445',
    'llm',
    '{"question":"b2"}'
  );

-- Linhas de outros revisores exercitam coordenador-alias, criador e master.
INSERT INTO public.response_equivalences (
  project_id,
  document_id,
  field_name,
  response_a_id,
  response_b_id,
  reviewer_id
) VALUES
  (
    '33333333-3333-3333-3333-333333333333',
    '44444444-4444-4444-4444-444444444444',
    'coordinator-case',
    '50000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000003',
    '11111111-1111-1111-1111-111111111111'
  ),
  (
    '33333333-3333-3333-3333-333333333333',
    '44444444-4444-4444-4444-444444444444',
    'creator-case',
    '50000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000004',
    '11111111-1111-1111-1111-111111111111'
  ),
  (
    '33333333-3333-3333-3333-333333333333',
    '44444444-4444-4444-4444-444444444444',
    'master-case',
    '50000000-0000-0000-0000-000000000002',
    '50000000-0000-0000-0000-000000000003',
    '11111111-1111-1111-1111-111111111111'
  ),
  (
    '33333333-3333-3333-3333-333333333333',
    '44444444-4444-4444-4444-444444444444',
    'foreign-member-case',
    '50000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000002',
    '77777777-7777-7777-7777-777777777777'
  ),
  (
    '33333333-3333-3333-3333-333333333334',
    '44444444-4444-4444-4444-444444444445',
    'project-b-case',
    '60000000-0000-0000-0000-000000000001',
    '60000000-0000-0000-0000-000000000002',
    'dddddddd-dddd-dddd-dddd-dddddddddddd'
  );

-- O Supabase local não concede DML desta tabela ao role por padrão. O GRANT é
-- revertido no ROLLBACK; assim o teste isola as policies RLS.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.response_equivalences TO authenticated;

-- Pesquisador-alias: cria, lê, atualiza e exclui como identidade canônica.
SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"22222222-2222-2222-2222-222222222222"}',
  true
);
SET LOCAL ROLE authenticated;

INSERT INTO public.response_equivalences (
  project_id,
  document_id,
  field_name,
  response_a_id,
  response_b_id,
  reviewer_id
) VALUES (
  '33333333-3333-3333-3333-333333333333',
  '44444444-4444-4444-4444-444444444444',
  'alias-case',
  '50000000-0000-0000-0000-000000000001',
  '50000000-0000-0000-0000-000000000002',
  '11111111-1111-1111-1111-111111111111'
);

DO $$
DECLARE
  visible_count integer;
BEGIN
  SELECT count(*) INTO visible_count
  FROM public.response_equivalences
  WHERE project_id = '33333333-3333-3333-3333-333333333333'
    AND field_name = 'alias-case'
    AND reviewer_id = '11111111-1111-1111-1111-111111111111';

  IF visible_count <> 1 THEN
    RAISE EXCEPTION
      'FALHOU #427: alias não lê a linha da identidade canônica (n=%)',
      visible_count;
  END IF;
END $$;

UPDATE public.response_equivalences
SET field_name = 'alias-case-updated'
WHERE project_id = '33333333-3333-3333-3333-333333333333'
  AND field_name = 'alias-case'
  AND reviewer_id = '11111111-1111-1111-1111-111111111111';

DELETE FROM public.response_equivalences
WHERE project_id = '33333333-3333-3333-3333-333333333333'
  AND field_name = 'alias-case-updated'
  AND reviewer_id = '11111111-1111-1111-1111-111111111111';

-- A leitura é compartilhada, mas ownership continua individual: o
-- pesquisador-alias não pode alterar nem excluir a linha do coordenador no
-- mesmo projeto acessível.
DO $$
DECLARE
  visible_count integer;
  affected_count integer;
BEGIN
  SELECT count(*) INTO visible_count
  FROM public.response_equivalences
  WHERE project_id = '33333333-3333-3333-3333-333333333333'
    AND field_name = 'foreign-member-case';
  IF visible_count <> 1 THEN
    RAISE EXCEPTION
      'FALHOU #427: alias não leu equivalência compartilhada (n=%)',
      visible_count;
  END IF;

  UPDATE public.response_equivalences
  SET field_name = 'foreign-member-case-updated'
  WHERE project_id = '33333333-3333-3333-3333-333333333333'
    AND field_name = 'foreign-member-case';
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count <> 0 THEN
    RAISE EXCEPTION
      'FALHOU #427: alias alterou equivalência de outro revisor (n=%)',
      affected_count;
  END IF;

  DELETE FROM public.response_equivalences
  WHERE project_id = '33333333-3333-3333-3333-333333333333'
    AND field_name = 'foreign-member-case';
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count <> 0 THEN
    RAISE EXCEPTION
      'FALHOU #427: alias excluiu equivalência de outro revisor (n=%)',
      affected_count;
  END IF;
END $$;

-- Mesmo dentro do projeto, o alias não pode assumir identidade arbitrária.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.response_equivalences (
      project_id,
      document_id,
      field_name,
      response_a_id,
      response_b_id,
      reviewer_id
    ) VALUES (
      '33333333-3333-3333-3333-333333333333',
      '44444444-4444-4444-4444-444444444444',
      'arbitrary-identity-attempt',
      '50000000-0000-0000-0000-000000000002',
      '50000000-0000-0000-0000-000000000004',
      'cccccccc-cccc-cccc-cccc-cccccccccccc'
    );
    RAISE EXCEPTION 'FALHOU #427: alias assumiu identidade arbitrária';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- O vínculo vale apenas no projeto A: B não pode ser lido nem alterado.
DO $$
DECLARE
  visible_count integer;
  affected_count integer;
BEGIN
  SELECT count(*) INTO visible_count
  FROM public.response_equivalences
  WHERE project_id = '33333333-3333-3333-3333-333333333334';
  IF visible_count <> 0 THEN
    RAISE EXCEPTION
      'FALHOU #427: alias leu equivalência de outro projeto (n=%)',
      visible_count;
  END IF;

  UPDATE public.response_equivalences
  SET field_name = 'cross-project-update'
  WHERE project_id = '33333333-3333-3333-3333-333333333334';
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count <> 0 THEN
    RAISE EXCEPTION
      'FALHOU #427: alias alterou equivalência de outro projeto (n=%)',
      affected_count;
  END IF;

  DELETE FROM public.response_equivalences
  WHERE project_id = '33333333-3333-3333-3333-333333333334';
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count <> 0 THEN
    RAISE EXCEPTION
      'FALHOU #427: alias excluiu equivalência de outro projeto (n=%)',
      affected_count;
  END IF;

  BEGIN
    INSERT INTO public.response_equivalences (
      project_id,
      document_id,
      field_name,
      response_a_id,
      response_b_id,
      reviewer_id
    ) VALUES (
      '33333333-3333-3333-3333-333333333334',
      '44444444-4444-4444-4444-444444444445',
      'cross-project-insert',
      '60000000-0000-0000-0000-000000000001',
      '60000000-0000-0000-0000-000000000002',
      '22222222-2222-2222-2222-222222222222'
    );
    RAISE EXCEPTION 'FALHOU #427: alias injetou equivalência em outro projeto';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END $$;

RESET ROLE;

-- Estranho ao projeto não lê nem injeta linha usando a própria identidade.
SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"99999999-9999-9999-9999-999999999999"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  visible_count integer;
BEGIN
  SELECT count(*) INTO visible_count
  FROM public.response_equivalences
  WHERE project_id = '33333333-3333-3333-3333-333333333333';
  IF visible_count <> 0 THEN
    RAISE EXCEPTION
      'FALHOU #427: estranho leu equivalência do projeto (n=%)',
      visible_count;
  END IF;

  BEGIN
    INSERT INTO public.response_equivalences (
      project_id,
      document_id,
      field_name,
      response_a_id,
      response_b_id,
      reviewer_id
    ) VALUES (
      '33333333-3333-3333-3333-333333333333',
      '44444444-4444-4444-4444-444444444444',
      'outsider-attempt',
      '50000000-0000-0000-0000-000000000003',
      '50000000-0000-0000-0000-000000000004',
      '99999999-9999-9999-9999-999999999999'
    );
    RAISE EXCEPTION 'FALHOU #427: estranho injetou equivalência no projeto';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END $$;

RESET ROLE;

-- A conta-alias do coordenador herda a autoridade da identidade canônica e
-- pode gerir linha criada por outro revisor.
SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"88888888-8888-8888-8888-888888888888"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  coordinated_count integer;
  affected_count integer;
BEGIN
  SELECT count(*) INTO coordinated_count
  FROM public.auth_user_coordinator_or_creator_project_ids()
    AS coordinated(project_id)
  WHERE coordinated.project_id = '33333333-3333-3333-3333-333333333333';
  IF coordinated_count <> 1 THEN
    RAISE EXCEPTION
      'FALHOU #427: alias do coordenador não resolveu o projeto (n=%)',
      coordinated_count;
  END IF;

  UPDATE public.response_equivalences
  SET field_name = 'coordinator-case-updated'
  WHERE project_id = '33333333-3333-3333-3333-333333333333'
    AND field_name = 'coordinator-case';
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count <> 1 THEN
    RAISE EXCEPTION
      'FALHOU #427: alias do coordenador não alterou linha alheia (n=%)',
      affected_count;
  END IF;

  DELETE FROM public.response_equivalences
  WHERE project_id = '33333333-3333-3333-3333-333333333333'
    AND field_name = 'coordinator-case-updated';
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count <> 1 THEN
    RAISE EXCEPTION
      'FALHOU #427: alias do coordenador não excluiu linha alheia (n=%)',
      affected_count;
  END IF;
END $$;

RESET ROLE;

-- O criador direto mantém autoridade sobre linha criada por outro revisor.
SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  affected_count integer;
BEGIN
  DELETE FROM public.response_equivalences
  WHERE project_id = '33333333-3333-3333-3333-333333333333'
    AND field_name = 'creator-case';
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count <> 1 THEN
    RAISE EXCEPTION
      'FALHOU #427: criador não geriu linha alheia (n=%)',
      affected_count;
  END IF;
END $$;

RESET ROLE;

-- Master mantém autoridade global, inclusive sem vínculo ao projeto.
SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  affected_count integer;
BEGIN
  DELETE FROM public.response_equivalences
  WHERE project_id = '33333333-3333-3333-3333-333333333333'
    AND field_name = 'master-case';
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count <> 1 THEN
    RAISE EXCEPTION
      'FALHOU #427: master não geriu linha alheia (n=%)',
      affected_count;
  END IF;
END $$;

RESET ROLE;

-- Auditoria final executada como dono das fixtures: as linhas legítimas de B e
-- do outro revisor permanecem; nenhuma tentativa bloqueada produziu estado.
DO $$
DECLARE
  project_b_count integer;
  foreign_member_count integer;
  forbidden_count integer;
BEGIN
  SELECT count(*) INTO project_b_count
  FROM public.response_equivalences
  WHERE project_id = '33333333-3333-3333-3333-333333333334'
    AND field_name = 'project-b-case';
  IF project_b_count <> 1 THEN
    RAISE EXCEPTION
      'FALHOU #427: isolamento alterou linha legítima de B (n=%)',
      project_b_count;
  END IF;

  SELECT count(*) INTO foreign_member_count
  FROM public.response_equivalences
  WHERE project_id = '33333333-3333-3333-3333-333333333333'
    AND field_name = 'foreign-member-case'
    AND reviewer_id = '77777777-7777-7777-7777-777777777777';
  IF foreign_member_count <> 1 THEN
    RAISE EXCEPTION
      'FALHOU #427: ownership alheio não foi preservado (n=%)',
      foreign_member_count;
  END IF;

  SELECT count(*) INTO forbidden_count
  FROM public.response_equivalences
  WHERE field_name IN (
    'alias-case',
    'alias-case-updated',
    'foreign-member-case-updated',
    'arbitrary-identity-attempt',
    'cross-project-update',
    'cross-project-insert',
    'outsider-attempt',
    'coordinator-case',
    'coordinator-case-updated',
    'creator-case',
    'master-case'
  );
  IF forbidden_count <> 0 THEN
    RAISE EXCEPTION
      'FALHOU #427: operações deixaram linhas inesperadas (n=%)',
      forbidden_count;
  END IF;

  RAISE NOTICE
    'OK #427: identidade efetiva e limites RLS validados para alias, coordenador, criador, master e estranhos';
END $$;

ROLLBACK;
