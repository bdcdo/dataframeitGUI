-- Regressão da identidade canônica por projeto (PR #440).
--
-- Como rodar após `npx supabase db reset`:
--   docker exec -i supabase_db_frontend psql -U postgres -d postgres \
--     -X -v ON_ERROR_STOP=1 < supabase/tests/canonical_project_identity_rls.test.sql
--
-- O teste inteiro roda em BEGIN ... ROLLBACK. As consultas RLS usam o role
-- authenticated e JWTs Clerk forjados; fixtures e invariantes usam o owner.

BEGIN;

-- ========== Fixtures ==========
-- Inserir em auth.users aciona handle_new_user() e cria os profiles com os
-- mesmos ids, preservando todas as FKs reais do schema.
INSERT INTO auth.users (id, email) VALUES
  ('10000000-0000-0000-0000-000000000001', 'owner@example.test'),
  ('10000000-0000-0000-0000-000000000002', 'canonical-researcher@example.test'),
  ('10000000-0000-0000-0000-000000000003', 'alias-researcher@example.test'),
  ('10000000-0000-0000-0000-000000000004', 'canonical-coordinator@example.test'),
  ('10000000-0000-0000-0000-000000000005', 'alias-coordinator@example.test'),
  ('10000000-0000-0000-0000-000000000006', 'canonical-resolver@example.test'),
  ('10000000-0000-0000-0000-000000000007', 'alias-resolver@example.test'),
  ('10000000-0000-0000-0000-000000000008', 'other-member@example.test'),
  ('10000000-0000-0000-0000-000000000009', 'other-project-member@example.test'),
  ('10000000-0000-0000-0000-00000000000a', 'other-project-alias@example.test'),
  ('10000000-0000-0000-0000-00000000000b', 'direct-member@example.test'),
  ('10000000-0000-0000-0000-00000000000c', 'creator-only@example.test'),
  ('10000000-0000-0000-0000-00000000000d', 'master@example.test'),
  ('10000000-0000-0000-0000-00000000000e', 'unify-source@example.test'),
  ('10000000-0000-0000-0000-00000000000f', 'second-alias@example.test');

UPDATE public.profiles
SET first_name = split_part(email, '@', 1);

INSERT INTO public.clerk_user_mapping
  (clerk_user_id, supabase_user_id, access_sync_version)
SELECT id::text, id, 1
FROM auth.users
WHERE id::text LIKE '10000000-0000-0000-0000-%';

INSERT INTO public.projects (id, name, created_by) VALUES
  ('20000000-0000-0000-0000-000000000001', 'Projeto canônico', '10000000-0000-0000-0000-000000000001'),
  ('20000000-0000-0000-0000-000000000002', 'Projeto isolado', '10000000-0000-0000-0000-000000000009'),
  ('20000000-0000-0000-0000-000000000003', 'Projeto apenas do criador', '10000000-0000-0000-0000-00000000000c');

INSERT INTO public.project_members
  (project_id, user_id, role, can_resolve)
VALUES
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'coordenador', false),
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'pesquisador', false),
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000004', 'coordenador', false),
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000006', 'pesquisador', true),
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000008', 'pesquisador', false),
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-00000000000b', 'pesquisador', false),
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-00000000000e', 'pesquisador', false),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000009', 'coordenador', false);

INSERT INTO public.member_email_links
  (id, project_id, member_user_id, email, linked_user_id, created_by)
VALUES
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'alias-researcher@example.test', '10000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001'),
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000004', 'alias-coordinator@example.test', '10000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001'),
  ('30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000006', 'alias-resolver@example.test', '10000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000001'),
  ('30000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000009', 'other-project-alias@example.test', '10000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000009');

INSERT INTO public.documents (id, project_id, title, text) VALUES
  ('40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Documento próprio', 'texto 1'),
  ('40000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'Documento alheio', 'texto 2'),
  ('40000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000002', 'Documento isolado', 'texto 3');

INSERT INTO public.assignments
  (id, project_id, document_id, user_id, status, type)
VALUES
  ('41000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'pendente', 'auto_revisao'),
  ('41000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000009', 'pendente', 'auto_revisao');

INSERT INTO public.responses
  (id, project_id, document_id, respondent_id, respondent_type, answers)
VALUES
  ('42000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'humano', '{"campo":"humano 1"}'),
  ('42000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', NULL, 'llm', '{"campo":"llm 1"}'),
  ('42000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000008', 'humano', '{"campo":"humano 2"}'),
  ('42000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000002', NULL, 'llm', '{"campo":"llm 2"}'),
  ('42000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000009', 'humano', '{"campo":"humano 3"}'),
  ('42000000-0000-0000-0000-000000000006', '20000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000003', NULL, 'llm', '{"campo":"llm 3"}');

INSERT INTO public.field_reviews
  (id, project_id, document_id, field_name, human_response_id,
   llm_response_id, self_reviewer_id)
VALUES
  ('43000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'campo', '42000000-0000-0000-0000-000000000001', '42000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002'),
  ('43000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000002', 'campo', '42000000-0000-0000-0000-000000000003', '42000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000008');

INSERT INTO public.reviews
  (id, project_id, document_id, field_name, reviewer_id, verdict)
VALUES
  ('44000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'campo', '10000000-0000-0000-0000-000000000001', 'humano'),
  ('44000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000003', 'campo', '10000000-0000-0000-0000-000000000009', 'humano'),
  ('44000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'campo', '10000000-0000-0000-0000-00000000000e', 'humano');

UPDATE public.reviews
SET resolved_at = now(),
    resolved_by = '10000000-0000-0000-0000-000000000005'
WHERE id = '44000000-0000-0000-0000-000000000003';

INSERT INTO public.verdict_acknowledgments
  (id, review_id, respondent_id, status)
VALUES
  ('45000000-0000-0000-0000-000000000002', '44000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000009', 'pending');

INSERT INTO public.response_equivalences
  (id, project_id, document_id, field_name, response_a_id, response_b_id,
   reviewer_id)
VALUES
  ('46000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000003', 'campo', '42000000-0000-0000-0000-000000000005', '42000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000009');

INSERT INTO public.project_comments
  (id, project_id, document_id, field_name, author_id, body, resolved_at,
   resolved_by)
VALUES
  ('47000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'campo', '10000000-0000-0000-0000-000000000008', 'Comentário do projeto canônico', NULL, NULL),
  ('47000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000003', 'campo', '10000000-0000-0000-0000-000000000009', 'Comentário isolado', NULL, NULL),
  ('47000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'auditoria', '10000000-0000-0000-0000-000000000005', 'Autoria histórica', now(), '10000000-0000-0000-0000-000000000005');

INSERT INTO public.project_comments
  (id, project_id, document_id, field_name, author_id, body, kind)
VALUES
  ('47000000-0000-0000-0000-000000000010', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'delete-policy', '10000000-0000-0000-0000-000000000001', 'Ambiguidade no projeto canônico', 'ambiguity'),
  ('47000000-0000-0000-0000-000000000011', '20000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000003', 'delete-policy', '10000000-0000-0000-0000-000000000009', 'Ambiguidade fora do projeto', 'ambiguity'),
  ('47000000-0000-0000-0000-000000000012', '20000000-0000-0000-0000-000000000003', NULL, 'delete-policy', '10000000-0000-0000-0000-00000000000c', 'Ambiguidade do projeto criado sem membership', 'ambiguity'),
  ('47000000-0000-0000-0000-000000000013', '20000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000003', 'delete-policy-master', '10000000-0000-0000-0000-000000000009', 'Ambiguidade disponível ao master', 'ambiguity');

INSERT INTO public.schema_suggestions
  (id, project_id, field_name, suggested_by, suggested_changes, reason)
VALUES
  ('48000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'campo', '10000000-0000-0000-0000-000000000008', '{"description":"p1"}', 'sugestão p1'),
  ('48000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'campo', '10000000-0000-0000-0000-000000000009', '{"description":"p2"}', 'sugestão p2');

INSERT INTO public.difficulty_resolutions
  (id, project_id, response_id, document_id, resolved_by)
VALUES
  ('49000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '42000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000005');

INSERT INTO public.error_resolutions
  (id, project_id, document_id, field_name, resolved_by)
VALUES
  ('49000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'auditoria', '10000000-0000-0000-0000-000000000005');

INSERT INTO public.note_resolutions
  (id, project_id, response_id, resolved_by)
VALUES
  ('49000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001', '42000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000005');

INSERT INTO public.assignment_batches
  (id, project_id, created_by)
VALUES
  ('4a000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000005');

INSERT INTO public.master_users (user_id)
VALUES ('10000000-0000-0000-0000-00000000000d');

-- O ambiente local não concede DML do schema public por padrão. O teste
-- concede apenas SELECT e deixa a RLS decidir quais linhas são visíveis.
GRANT SELECT ON public.profiles, public.projects, public.project_members,
  public.member_email_links, public.assignments, public.field_reviews,
  public.reviews, public.project_comments, public.schema_suggestions
  TO authenticated;
GRANT UPDATE (role) ON public.project_members TO authenticated;
GRANT UPDATE ON public.field_reviews TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.verdict_acknowledgments, public.response_equivalences,
  public.researcher_field_orders
  TO authenticated;
GRANT INSERT, UPDATE
  ON public.project_comments, public.schema_suggestions
  TO authenticated;
GRANT DELETE ON public.project_comments TO authenticated;

-- ========== Alias de pesquisador: papel/flag brutos não vazam ==========
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000003","supabase_uid":"10000000-0000-0000-0000-000000000003"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM public.auth_user_project_ids()
  WHERE auth_user_project_ids = '20000000-0000-0000-0000-000000000001';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALHOU pesquisador alias: projeto canônico não resolvido';
  END IF;

  SELECT count(*) INTO n FROM public.auth_user_coordinator_project_ids();
  IF n <> 0 THEN
    RAISE EXCEPTION 'FALHOU identidade: alias pesquisador ganhou coordenação';
  END IF;

  SELECT count(*) INTO n FROM public.auth_user_resolver_project_ids();
  IF n <> 0 THEN
    RAISE EXCEPTION 'FALHOU identidade: alias pesquisador ganhou can_resolve';
  END IF;

  SELECT count(*) INTO n
  FROM public.auth_user_member_identity_ids(
    '20000000-0000-0000-0000-000000000001'
  );
  IF n <> 1 OR NOT EXISTS (
    SELECT 1
    FROM public.auth_user_member_identity_ids(
      '20000000-0000-0000-0000-000000000001'
    )
    WHERE auth_user_member_identity_ids =
      '10000000-0000-0000-0000-000000000002'
  ) OR EXISTS (
    SELECT 1
    FROM public.auth_user_member_identity_ids(
      '20000000-0000-0000-0000-000000000001'
    )
    WHERE auth_user_member_identity_ids =
      '10000000-0000-0000-0000-000000000003'
  ) THEN
    RAISE EXCEPTION 'FALHOU identidade: alias ainda exerce o id bruto';
  END IF;

  SELECT count(*) INTO n FROM public.projects
  WHERE id IN (
    '20000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000002',
    '20000000-0000-0000-0000-000000000003'
  );
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALHOU pesquisador alias: esperava 1 projeto, viu %', n;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = '10000000-0000-0000-0000-000000000002'
  ) OR EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = '10000000-0000-0000-0000-000000000009'
  ) THEN
    RAISE EXCEPTION 'FALHOU profiles: equipe canônica não foi isolada';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.assignments
    WHERE id = '41000000-0000-0000-0000-000000000001'
  ) OR EXISTS (
    SELECT 1 FROM public.assignments
    WHERE id = '41000000-0000-0000-0000-000000000002'
  ) THEN
    RAISE EXCEPTION 'FALHOU assignments: acesso canônico/cross-project incorreto';
  END IF;

  SELECT count(*) INTO n FROM public.field_reviews
  WHERE id IN (
    '43000000-0000-0000-0000-000000000001',
    '43000000-0000-0000-0000-000000000002'
  );
  IF n <> 1 OR NOT EXISTS (
    SELECT 1 FROM public.field_reviews
    WHERE id = '43000000-0000-0000-0000-000000000001'
  ) THEN
    RAISE EXCEPTION 'FALHOU field_reviews: pesquisador alias viu fila incorreta';
  END IF;

  INSERT INTO public.verdict_acknowledgments
    (id, review_id, respondent_id, status)
  VALUES
    ('45000000-0000-0000-0000-000000000001', '44000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'pending')
  ON CONFLICT (review_id, respondent_id)
  DO UPDATE SET status = EXCLUDED.status;

  UPDATE public.verdict_acknowledgments
  SET status = 'acknowledged'
  WHERE id = '45000000-0000-0000-0000-000000000001';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALHOU acknowledgment: UPDATE canônico alterou % linhas', n;
  END IF;

  BEGIN
    INSERT INTO public.verdict_acknowledgments
      (review_id, respondent_id, status)
    VALUES
      ('44000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-00000000000a', 'pending');
    RAISE EXCEPTION 'TESTE FALHOU: acknowledgment cross-project foi aceito';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;

  SELECT count(*) INTO n
  FROM public.verdict_acknowledgments
  WHERE id IN (
    '45000000-0000-0000-0000-000000000001',
    '45000000-0000-0000-0000-000000000002'
  );
  IF n <> 1 OR NOT EXISTS (
    SELECT 1 FROM public.verdict_acknowledgments
    WHERE id = '45000000-0000-0000-0000-000000000001'
      AND respondent_id = '10000000-0000-0000-0000-000000000002'
      AND status = 'acknowledged'
  ) THEN
    RAISE EXCEPTION 'FALHOU acknowledgment: leitura/escrita canônica ou isolamento';
  END IF;

  INSERT INTO public.response_equivalences
    (id, project_id, document_id, field_name, response_a_id,
     response_b_id, reviewer_id)
  VALUES
    ('46000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'campo', '42000000-0000-0000-0000-000000000001', '42000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002');

  DELETE FROM public.response_equivalences
  WHERE id = '46000000-0000-0000-0000-000000000001';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALHOU equivalência: DELETE canônico alterou % linhas', n;
  END IF;

  INSERT INTO public.response_equivalences
    (id, project_id, document_id, field_name, response_a_id,
     response_b_id, reviewer_id)
  VALUES
    ('46000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'campo', '42000000-0000-0000-0000-000000000001', '42000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002');

  BEGIN
    INSERT INTO public.response_equivalences
      (project_id, document_id, field_name, response_a_id, response_b_id,
       reviewer_id)
    VALUES
      ('20000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000003', 'campo-cross', '42000000-0000-0000-0000-000000000005', '42000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000009');
    RAISE EXCEPTION 'TESTE FALHOU: equivalência cross-project foi aceita';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;

  SELECT count(*) INTO n
  FROM public.response_equivalences
  WHERE id IN (
    '46000000-0000-0000-0000-000000000001',
    '46000000-0000-0000-0000-000000000002'
  );
  IF n <> 1 OR NOT EXISTS (
    SELECT 1 FROM public.response_equivalences
    WHERE id = '46000000-0000-0000-0000-000000000001'
      AND reviewer_id = '10000000-0000-0000-0000-000000000002'
  ) THEN
    RAISE EXCEPTION 'FALHOU equivalência: escrita canônica ou isolamento';
  END IF;

  INSERT INTO public.researcher_field_orders
    (project_id, user_id, field_order)
  VALUES
    ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', '["campo"]')
  ON CONFLICT (project_id, user_id)
  DO UPDATE SET field_order = EXCLUDED.field_order;

  UPDATE public.researcher_field_orders
  SET field_order = '["campo", "outro"]'
  WHERE project_id = '20000000-0000-0000-0000-000000000001'
    AND user_id = '10000000-0000-0000-0000-000000000002';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALHOU field order: UPDATE canônico alterou % linhas', n;
  END IF;

  BEGIN
    INSERT INTO public.researcher_field_orders
      (project_id, user_id, field_order)
    VALUES
      ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003', '["raw"]');
    RAISE EXCEPTION 'TESTE FALHOU: field order aceitou identidade bruta do alias';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM public.researcher_field_orders
    WHERE project_id = '20000000-0000-0000-0000-000000000001'
      AND user_id = '10000000-0000-0000-0000-000000000002'
      AND field_order = '["campo", "outro"]'
  ) THEN
    RAISE EXCEPTION 'FALHOU field order: linha canônica não é legível';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.project_comments
    WHERE id = '47000000-0000-0000-0000-000000000001'
  ) OR EXISTS (
    SELECT 1 FROM public.project_comments
    WHERE id = '47000000-0000-0000-0000-000000000002'
  ) THEN
    RAISE EXCEPTION 'FALHOU comments: acesso canônico/cross-project incorreto';
  END IF;

  DELETE FROM public.project_comments
  WHERE id = '47000000-0000-0000-0000-000000000010';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION
      'FALHOU comments: alias não removeu ambiguidade do projeto canônico';
  END IF;

  DELETE FROM public.project_comments
  WHERE id = '47000000-0000-0000-0000-000000000011';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION
      'FALHOU comments: alias removeu ambiguidade de outro projeto';
  END IF;

  INSERT INTO public.project_comments
    (id, project_id, author_id, body)
  VALUES
    ('47000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003', 'Comentário do alias');

  BEGIN
    INSERT INTO public.project_comments
      (project_id, document_id, field_name, author_id, body, source_field_review_id)
    VALUES
      ('20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'campo', '10000000-0000-0000-0000-000000000003', 'Tentativa de forjar proveniência automática', '43000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION
      'TESTE FALHOU: cliente autenticado forjou proveniência automática';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;

  BEGIN
    INSERT INTO public.project_comments
      (project_id, author_id, body)
    VALUES
      ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'Autoria canônica indevida');
    RAISE EXCEPTION 'TESTE FALHOU: comment aceitou autoria não autenticada';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM public.schema_suggestions
    WHERE id = '48000000-0000-0000-0000-000000000001'
  ) OR EXISTS (
    SELECT 1 FROM public.schema_suggestions
    WHERE id = '48000000-0000-0000-0000-000000000002'
  ) THEN
    RAISE EXCEPTION 'FALHOU suggestions: acesso canônico/cross-project incorreto';
  END IF;

  INSERT INTO public.schema_suggestions
    (id, project_id, field_name, suggested_by, suggested_changes)
  VALUES
    ('48000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001', 'campo', '10000000-0000-0000-0000-000000000003', '{"description":"alias"}');

  BEGIN
    INSERT INTO public.schema_suggestions
      (project_id, field_name, suggested_by, suggested_changes)
    VALUES
      ('20000000-0000-0000-0000-000000000002', 'campo', '10000000-0000-0000-0000-000000000003', '{"description":"cross"}');
    RAISE EXCEPTION 'TESTE FALHOU: suggestion cross-project foi aceita';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;

  RAISE NOTICE 'OK: alias pesquisador usa uma identidade canônica em todas as filas';
END;
$$;

RESET ROLE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.project_comments
    WHERE id = '47000000-0000-0000-0000-000000000010'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.project_comments
    WHERE id = '47000000-0000-0000-0000-000000000011'
  ) THEN
    RAISE EXCEPTION
      'FALHOU comments: DELETE canônico não preservou o isolamento por projeto';
  END IF;
  RAISE NOTICE
    'OK: alias remove ambiguidade apenas no projeto canônico';
END;
$$;

-- ========== Alias de coordenador: papel canônico libera viewAs ==========
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000005","supabase_uid":"10000000-0000-0000-0000-000000000005"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM public.auth_user_coordinator_project_ids()
  WHERE auth_user_coordinator_project_ids = '20000000-0000-0000-0000-000000000001';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALHOU coordenador alias: papel canônico não herdado';
  END IF;

  SELECT count(*) INTO n FROM public.field_reviews
  WHERE id IN (
    '43000000-0000-0000-0000-000000000001',
    '43000000-0000-0000-0000-000000000002'
  );
  IF n <> 2 THEN
    RAISE EXCEPTION 'FALHOU coordenador alias: esperava 2 field_reviews, viu %', n;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = '10000000-0000-0000-0000-000000000008'
  ) THEN
    RAISE EXCEPTION 'FALHOU coordenador alias: perfil de pesquisador invisível';
  END IF;

  BEGIN
    UPDATE public.project_members
    SET role = 'pesquisador'
    WHERE project_id = '20000000-0000-0000-0000-000000000001'
      AND user_id = '10000000-0000-0000-0000-000000000004';
    RAISE EXCEPTION
      'TESTE FALHOU: alias coordenador alterou a membership canônica própria';
  EXCEPTION
    WHEN insufficient_privilege THEN
      IF SQLERRM <> 'Members cannot change their own role on project_members' THEN
        RAISE;
      END IF;
  END;

  UPDATE public.project_members
  SET role = 'coordenador'
  WHERE project_id = '20000000-0000-0000-0000-000000000001'
    AND user_id = '10000000-0000-0000-0000-000000000008';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION
      'FALHOU guard: coordenador alias não alterou membership de terceiro';
  END IF;
  UPDATE public.project_members
  SET role = 'pesquisador'
  WHERE project_id = '20000000-0000-0000-0000-000000000001'
    AND user_id = '10000000-0000-0000-0000-000000000008';

  UPDATE public.verdict_acknowledgments
  SET resolved_at = now(),
      resolved_by = '10000000-0000-0000-0000-000000000004'
  WHERE id = '45000000-0000-0000-0000-000000000001';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALHOU coordenador alias: acknowledgment não atualizável';
  END IF;

  UPDATE public.response_equivalences
  SET field_name = 'campo-coordenado'
  WHERE id = '46000000-0000-0000-0000-000000000001';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALHOU coordenador alias: equivalência não atualizável';
  END IF;

  UPDATE public.project_comments
  SET body = 'Comentário atualizado pelo coordenador alias'
  WHERE id = '47000000-0000-0000-0000-000000000001';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALHOU coordenador alias: comment alheio não atualizável';
  END IF;

  BEGIN
    UPDATE public.project_comments
    SET source_field_review_id =
      '43000000-0000-0000-0000-000000000001'
    WHERE id = '47000000-0000-0000-0000-000000000001';
    RAISE EXCEPTION
      'TESTE FALHOU: cliente autenticado alterou proveniência automática';
  EXCEPTION
    WHEN insufficient_privilege THEN
      IF SQLERRM <>
        'source_field_review_id is reserved for automatic project comments'
      THEN
        RAISE;
      END IF;
  END;

  UPDATE public.schema_suggestions
  SET status = 'approved'
  WHERE id = '48000000-0000-0000-0000-000000000001';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALHOU coordenador alias: suggestion não atualizável';
  END IF;

  RAISE NOTICE 'OK: alias coordenador vê e gerencia filas de terceiros';
END;
$$;

RESET ROLE;

-- ========== Alias de resolver ==========
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000007","supabase_uid":"10000000-0000-0000-0000-000000000007"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM public.auth_user_resolver_project_ids()
  WHERE auth_user_resolver_project_ids = '20000000-0000-0000-0000-000000000001';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALHOU resolver alias: can_resolve canônico não herdado';
  END IF;

  SELECT count(*) INTO n FROM public.auth_user_coordinator_project_ids();
  IF n <> 0 THEN
    RAISE EXCEPTION 'FALHOU resolver alias: ganhou coordenação indevida';
  END IF;

  RAISE NOTICE 'OK: alias herda can_resolve sem herdar coordenação';
END;
$$;

RESET ROLE;

-- ========== Isolamento, membro direto e ownership bruto ==========
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-00000000000a","supabase_uid":"10000000-0000-0000-0000-00000000000a"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM public.projects
  WHERE id IN (
    '20000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000002'
  );
  IF n <> 1 OR NOT EXISTS (
    SELECT 1 FROM public.projects
    WHERE id = '20000000-0000-0000-0000-000000000002'
  ) THEN
    RAISE EXCEPTION 'FALHOU isolamento: alias de outro projeto atravessou escopo';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = '10000000-0000-0000-0000-000000000002'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = '10000000-0000-0000-0000-000000000009'
  ) THEN
    RAISE EXCEPTION 'FALHOU isolamento de profiles entre projetos';
  END IF;

  SELECT count(*) INTO n FROM public.assignments
  WHERE id IN (
    '41000000-0000-0000-0000-000000000001',
    '41000000-0000-0000-0000-000000000002'
  );
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALHOU isolamento de assignments: viu % linhas', n;
  END IF;

  SELECT count(*) INTO n FROM public.verdict_acknowledgments
  WHERE id IN (
    '45000000-0000-0000-0000-000000000001',
    '45000000-0000-0000-0000-000000000002'
  );
  IF n <> 1 OR NOT EXISTS (
    SELECT 1 FROM public.verdict_acknowledgments
    WHERE id = '45000000-0000-0000-0000-000000000002'
  ) THEN
    RAISE EXCEPTION 'FALHOU isolamento de acknowledgments';
  END IF;

  SELECT count(*) INTO n FROM public.response_equivalences
  WHERE id IN (
    '46000000-0000-0000-0000-000000000001',
    '46000000-0000-0000-0000-000000000002'
  );
  IF n <> 1 OR NOT EXISTS (
    SELECT 1 FROM public.response_equivalences
    WHERE id = '46000000-0000-0000-0000-000000000002'
  ) THEN
    RAISE EXCEPTION 'FALHOU isolamento de response_equivalences';
  END IF;

  RAISE NOTICE 'OK: alias permanece isolado ao projeto do vínculo';
END;
$$;

RESET ROLE;

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-00000000000b","supabase_uid":"10000000-0000-0000-0000-00000000000b"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  n integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.auth_user_project_ids()
    WHERE auth_user_project_ids = '20000000-0000-0000-0000-000000000001'
  ) THEN
    RAISE EXCEPTION 'FALHOU membro direto: projeto deixou de ser acessível';
  END IF;
  RAISE NOTICE 'OK: membership direta não regrediu';
END;
$$;

RESET ROLE;

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-00000000000c","supabase_uid":"10000000-0000-0000-0000-00000000000c"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  member_projects integer;
  accessible_projects integer;
  managed_projects integer;
  deleted_comments integer;
BEGIN
  SELECT count(*) INTO member_projects
  FROM public.auth_user_project_ids();
  SELECT count(*) INTO accessible_projects
  FROM public.auth_user_accessible_project_ids()
  WHERE auth_user_accessible_project_ids = '20000000-0000-0000-0000-000000000003';
  SELECT count(*) INTO managed_projects
  FROM public.auth_user_coordinator_or_creator_project_ids()
  WHERE auth_user_coordinator_or_creator_project_ids = '20000000-0000-0000-0000-000000000003';

  IF member_projects <> 0 OR accessible_projects <> 1 OR managed_projects <> 1 THEN
    RAISE EXCEPTION
      'FALHOU creator raw: member=%, access=%, manage=%',
      member_projects, accessible_projects, managed_projects;
  END IF;

  DELETE FROM public.project_comments
  WHERE id = '47000000-0000-0000-0000-000000000012';
  GET DIAGNOSTICS deleted_comments = ROW_COUNT;
  IF deleted_comments <> 1 THEN
    RAISE EXCEPTION
      'FALHOU creator raw: comentário de ambiguidade não foi excluído';
  END IF;

  RAISE NOTICE 'OK: ownership continua ligado à conta bruta';
END;
$$;

RESET ROLE;

-- ========== Master ==========
SELECT set_config('request.jwt.claims', '{}', true);

-- Prepara uma linha cuja fase final seria estruturalmente válida. Assim o caso
-- abaixo prova a autorização por ator, sem depender de uma CHECK lateral.
UPDATE public.field_reviews
SET self_verdict = 'contesta_llm',
    self_justification = 'contestação preparada para o teste master',
    self_reviewed_at = now(),
    arbitrator_id = '10000000-0000-0000-0000-000000000006',
    blind_verdict = 'humano',
    blind_decided_at = now()
WHERE id = '43000000-0000-0000-0000-000000000002';

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-00000000000d","supabase_uid":"10000000-0000-0000-0000-00000000000d"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  n integer;
  blocked boolean := false;
BEGIN
  SELECT count(*) INTO n FROM public.projects
  WHERE id IN (
    '20000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000002',
    '20000000-0000-0000-0000-000000000003'
  );
  IF n <> 3 THEN
    RAISE EXCEPTION 'FALHOU master: esperava 3 projetos, viu %', n;
  END IF;

  SELECT count(*) INTO n FROM public.field_reviews
  WHERE id IN (
    '43000000-0000-0000-0000-000000000001',
    '43000000-0000-0000-0000-000000000002'
  );
  IF n <> 2 THEN
    RAISE EXCEPTION 'FALHOU master: esperava 2 field_reviews, viu %', n;
  END IF;

  SELECT count(*) INTO n FROM public.verdict_acknowledgments
  WHERE id IN (
    '45000000-0000-0000-0000-000000000001',
    '45000000-0000-0000-0000-000000000002'
  );
  IF n <> 2 THEN
    RAISE EXCEPTION 'FALHOU master: esperava 2 acknowledgments, viu %', n;
  END IF;

  SELECT count(*) INTO n FROM public.response_equivalences
  WHERE id IN (
    '46000000-0000-0000-0000-000000000001',
    '46000000-0000-0000-0000-000000000002'
  );
  IF n <> 2 THEN
    RAISE EXCEPTION 'FALHOU master: esperava 2 equivalências, viu %', n;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = '10000000-0000-0000-0000-000000000009'
  ) THEN
    RAISE EXCEPTION 'FALHOU master: profile alheio invisível';
  END IF;

  DELETE FROM public.project_comments
  WHERE id = '47000000-0000-0000-0000-000000000013';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALHOU master: comentário de ambiguidade não foi excluído';
  END IF;

  BEGIN
    UPDATE public.field_reviews
    SET final_verdict = 'humano',
        final_decided_at = '2000-01-01T00:00:00Z'
    WHERE id = '43000000-0000-0000-0000-000000000002';
  EXCEPTION
    WHEN insufficient_privilege THEN
      blocked := true;
  END;
  IF NOT blocked OR EXISTS (
    SELECT 1
    FROM public.field_reviews
    WHERE id = '43000000-0000-0000-0000-000000000002'
      AND final_verdict IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'FALHOU master: acesso global forjou fase final';
  END IF;

  INSERT INTO public.researcher_field_orders
    (project_id, user_id, field_order)
  VALUES
    ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-00000000000d', '["master"]');

  SELECT count(*) INTO n
  FROM public.researcher_field_orders
  WHERE project_id = '20000000-0000-0000-0000-000000000001'
    AND user_id = '10000000-0000-0000-0000-00000000000d';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALHOU master: preferência própria não foi persistida';
  END IF;

  BEGIN
    INSERT INTO public.researcher_field_orders
      (project_id, user_id, field_order)
    VALUES
      ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000008', '["terceiro"]');
    RAISE EXCEPTION 'TESTE FALHOU: master alterou preferência de terceiro';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;

  RAISE NOTICE 'OK: acesso master não regrediu';
END;
$$;

RESET ROLE;

-- ========== Transições de field_reviews são fases fechadas ==========
SELECT set_config('request.jwt.claims', '{}', true);

UPDATE public.field_reviews
SET self_verdict = NULL,
    self_justification = NULL,
    self_reviewed_at = NULL,
    arbitrator_id = NULL,
    blind_verdict = NULL,
    blind_decided_at = NULL
WHERE id = '43000000-0000-0000-0000-000000000002';

-- Estados de fase malformados são irrepresentáveis mesmo em escrita interna,
-- onde o trigger de autorização é deliberadamente bypassado.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.field_reviews (
      id, project_id, document_id, field_name, human_response_id,
      llm_response_id, self_reviewer_id, self_verdict
    ) VALUES (
      '43100000-0000-0000-0000-000000000001',
      '20000000-0000-0000-0000-000000000001',
      '40000000-0000-0000-0000-000000000001',
      'invalid-self-timestamp',
      '42000000-0000-0000-0000-000000000001',
      '42000000-0000-0000-0000-000000000002',
      '10000000-0000-0000-0000-000000000002',
      'admite_erro'
    );
    RAISE EXCEPTION 'TESTE FALHOU: self verdict sem timestamp foi aceito';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  BEGIN
    INSERT INTO public.field_reviews (
      id, project_id, document_id, field_name, human_response_id,
      llm_response_id, self_reviewer_id, arbitrator_id
    ) VALUES (
      '43100000-0000-0000-0000-000000000002',
      '20000000-0000-0000-0000-000000000001',
      '40000000-0000-0000-0000-000000000001',
      'invalid-arbitrator-phase',
      '42000000-0000-0000-0000-000000000001',
      '42000000-0000-0000-0000-000000000002',
      '10000000-0000-0000-0000-000000000002',
      '10000000-0000-0000-0000-000000000006'
    );
    RAISE EXCEPTION 'TESTE FALHOU: árbitro sem contestação foi aceito';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  BEGIN
    INSERT INTO public.field_reviews (
      id, project_id, document_id, field_name, human_response_id,
      llm_response_id, self_reviewer_id, self_verdict, self_reviewed_at,
      arbitrator_id, blind_verdict
    ) VALUES (
      '43100000-0000-0000-0000-000000000003',
      '20000000-0000-0000-0000-000000000001',
      '40000000-0000-0000-0000-000000000001',
      'invalid-blind-timestamp',
      '42000000-0000-0000-0000-000000000001',
      '42000000-0000-0000-0000-000000000002',
      '10000000-0000-0000-0000-000000000002',
      'contesta_llm', now(),
      '10000000-0000-0000-0000-000000000006', 'humano'
    );
    RAISE EXCEPTION 'TESTE FALHOU: blind verdict sem timestamp foi aceito';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  BEGIN
    INSERT INTO public.field_reviews (
      id, project_id, document_id, field_name, human_response_id,
      llm_response_id, self_reviewer_id, self_verdict, self_reviewed_at,
      arbitrator_id, final_verdict, final_decided_at
    ) VALUES (
      '43100000-0000-0000-0000-000000000004',
      '20000000-0000-0000-0000-000000000001',
      '40000000-0000-0000-0000-000000000001',
      'invalid-final-phase',
      '42000000-0000-0000-0000-000000000001',
      '42000000-0000-0000-0000-000000000002',
      '10000000-0000-0000-0000-000000000002',
      'contesta_llm', now(),
      '10000000-0000-0000-0000-000000000006', 'humano', now()
    );
    RAISE EXCEPTION 'TESTE FALHOU: final sem blind foi aceito';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  BEGIN
    INSERT INTO public.field_reviews (
      id, project_id, document_id, field_name, human_response_id,
      llm_response_id, self_reviewer_id, self_verdict, self_reviewed_at,
      arbitrator_id, blind_verdict, blind_decided_at, final_verdict,
      final_decided_at, question_improvement_suggestion
    ) VALUES (
      '43100000-0000-0000-0000-000000000005',
      '20000000-0000-0000-0000-000000000001',
      '40000000-0000-0000-0000-000000000001',
      'invalid-llm-suggestion',
      '42000000-0000-0000-0000-000000000001',
      '42000000-0000-0000-0000-000000000002',
      '10000000-0000-0000-0000-000000000002',
      'contesta_llm', now(),
      '10000000-0000-0000-0000-000000000006', 'humano', now(),
      'llm', now(), '  '
    );
    RAISE EXCEPTION 'TESTE FALHOU: final LLM sem sugestão foi aceito';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  RAISE NOTICE 'OK: CHECKs rejeitam combinações adversariais de fase';
END;
$$;

CREATE TEMP TABLE phase_timestamp_bounds (
  phase text PRIMARY KEY,
  lower_at timestamptz NOT NULL,
  upper_at timestamptz
);
GRANT SELECT, INSERT, UPDATE ON phase_timestamp_bounds TO authenticated;

-- A conta-alias exerce a fase self do membro canônico, mas não consegue tocar
-- colunas de arbitragem. O banco, e não o payload, define o timestamp.
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000003","supabase_uid":"10000000-0000-0000-0000-000000000003"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
BEGIN
  BEGIN
    UPDATE public.field_reviews
    SET final_verdict = 'humano'
    WHERE id = '43000000-0000-0000-0000-000000000001';
    RAISE EXCEPTION
      'TESTE FALHOU: self-reviewer escreveu fase final';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;

END;
$$;

INSERT INTO phase_timestamp_bounds (phase, lower_at)
VALUES ('self', clock_timestamp());
UPDATE public.field_reviews
SET self_verdict = 'contesta_llm',
    self_justification = 'discordância fundamentada',
    self_reviewed_at = '2000-01-01T00:00:00Z'
WHERE id = '43000000-0000-0000-0000-000000000001';
UPDATE phase_timestamp_bounds
SET upper_at = clock_timestamp()
WHERE phase = 'self';

DO $$
DECLARE
  v_persisted_at timestamptz;
  v_lower_at timestamptz;
  v_upper_at timestamptz;
BEGIN
  SELECT review.self_reviewed_at, bounds.lower_at, bounds.upper_at
  INTO v_persisted_at, v_lower_at, v_upper_at
  FROM public.field_reviews review
  CROSS JOIN phase_timestamp_bounds bounds
  WHERE review.id = '43000000-0000-0000-0000-000000000001'
    AND bounds.phase = 'self';
  IF v_persisted_at IS NULL
     OR v_persisted_at < v_lower_at
     OR v_persisted_at > v_upper_at
     OR v_persisted_at = '2000-01-01T00:00:00Z'::timestamptz
  THEN
    RAISE EXCEPTION
      'FALHOU timestamp self: persisted=%, intervalo=[%,%]',
      v_persisted_at, v_lower_at, v_upper_at;
  END IF;

  BEGIN
    UPDATE public.field_reviews
    SET arbitrator_id = '10000000-0000-0000-0000-000000000006'
    WHERE id = '43000000-0000-0000-0000-000000000001';
    RAISE EXCEPTION
      'TESTE FALHOU: self-reviewer escolheu o próprio árbitro';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;
END;
$$;

RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);

UPDATE public.field_reviews
SET arbitrator_id = '10000000-0000-0000-0000-000000000006'
WHERE id = '43000000-0000-0000-0000-000000000001';

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000006","supabase_uid":"10000000-0000-0000-0000-000000000006"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
BEGIN
  BEGIN
    UPDATE public.field_reviews
    SET self_justification = 'árbitro adulterou a justificativa'
    WHERE id = '43000000-0000-0000-0000-000000000001';
    RAISE EXCEPTION
      'TESTE FALHOU: árbitro alterou fase self';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;
END;
$$;

INSERT INTO phase_timestamp_bounds (phase, lower_at)
VALUES ('blind', clock_timestamp());
UPDATE public.field_reviews
SET blind_verdict = 'humano',
    blind_decided_at = '2000-01-01T00:00:00Z'
WHERE id = '43000000-0000-0000-0000-000000000001';
UPDATE phase_timestamp_bounds
SET upper_at = clock_timestamp()
WHERE phase = 'blind';

DO $$
DECLARE
  v_persisted_at timestamptz;
  v_lower_at timestamptz;
  v_upper_at timestamptz;
BEGIN
  SELECT review.blind_decided_at, bounds.lower_at, bounds.upper_at
  INTO v_persisted_at, v_lower_at, v_upper_at
  FROM public.field_reviews review
  CROSS JOIN phase_timestamp_bounds bounds
  WHERE review.id = '43000000-0000-0000-0000-000000000001'
    AND bounds.phase = 'blind';
  IF v_persisted_at IS NULL
     OR v_persisted_at < v_lower_at
     OR v_persisted_at > v_upper_at
     OR v_persisted_at = '2000-01-01T00:00:00Z'::timestamptz
  THEN
    RAISE EXCEPTION
      'FALHOU timestamp blind: persisted=%, intervalo=[%,%]',
      v_persisted_at, v_lower_at, v_upper_at;
  END IF;
END;
$$;

INSERT INTO phase_timestamp_bounds (phase, lower_at)
VALUES ('final', clock_timestamp());
UPDATE public.field_reviews
SET final_verdict = 'llm',
    final_decided_at = '2000-01-01T00:00:00Z',
    question_improvement_suggestion = 'Tornar a pergunta mais precisa.'
WHERE id = '43000000-0000-0000-0000-000000000001';
UPDATE phase_timestamp_bounds
SET upper_at = clock_timestamp()
WHERE phase = 'final';

DO $$
DECLARE
  v_persisted_at timestamptz;
  v_lower_at timestamptz;
  v_upper_at timestamptz;
BEGIN
  SELECT review.final_decided_at, bounds.lower_at, bounds.upper_at
  INTO v_persisted_at, v_lower_at, v_upper_at
  FROM public.field_reviews review
  CROSS JOIN phase_timestamp_bounds bounds
  WHERE review.id = '43000000-0000-0000-0000-000000000001'
    AND bounds.phase = 'final';
  IF v_persisted_at IS NULL
     OR v_persisted_at < v_lower_at
     OR v_persisted_at > v_upper_at
     OR v_persisted_at = '2000-01-01T00:00:00Z'::timestamptz
  THEN
    RAISE EXCEPTION
      'FALHOU timestamp final: persisted=%, intervalo=[%,%]',
      v_persisted_at, v_lower_at, v_upper_at;
  END IF;
  RAISE NOTICE 'OK: fases e timestamps de field_reviews são invariantes do banco';
END;
$$;

RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);

-- A origem e o comentário precisam pertencer ao mesmo projeto. A FK composta
-- rejeita um UUID de revisão válido quando ele é apresentado sob outro escopo.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.project_comments (
      id,
      project_id,
      document_id,
      field_name,
      author_id,
      body,
      source_field_review_id
    ) VALUES (
      '47100000-0000-0000-0000-000000000001',
      '20000000-0000-0000-0000-000000000002',
      '40000000-0000-0000-0000-000000000003',
      'campo',
      '10000000-0000-0000-0000-000000000009',
      'Proveniência cross-project inválida',
      '43000000-0000-0000-0000-000000000001'
    );
    RAISE EXCEPTION 'TESTE FALHOU: proveniência cross-project foi aceita';
  EXCEPTION
    WHEN foreign_key_violation THEN
      RAISE NOTICE 'OK: proveniência automática é escopada pelo projeto';
  END;
END;
$$;

-- Mesmo dentro do projeto, documento e campo fazem parte da identidade da
-- revisão de origem; nenhum dos dois pode ser trocado ou omitido.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.project_comments (
      id, project_id, document_id, field_name, author_id, body,
      source_field_review_id
    ) VALUES (
      '47100000-0000-0000-0000-000000000002',
      '20000000-0000-0000-0000-000000000001',
      '40000000-0000-0000-0000-000000000002',
      'campo',
      '10000000-0000-0000-0000-000000000001',
      'Documento incompatível com a revisão',
      '43000000-0000-0000-0000-000000000001'
    );
    RAISE EXCEPTION 'TESTE FALHOU: origem aceitou outro documento';
  EXCEPTION
    WHEN foreign_key_violation THEN
      NULL;
  END;

  BEGIN
    INSERT INTO public.project_comments (
      id, project_id, document_id, field_name, author_id, body,
      source_field_review_id
    ) VALUES (
      '47100000-0000-0000-0000-000000000003',
      '20000000-0000-0000-0000-000000000001',
      '40000000-0000-0000-0000-000000000001',
      'outro-campo',
      '10000000-0000-0000-0000-000000000001',
      'Campo incompatível com a revisão',
      '43000000-0000-0000-0000-000000000001'
    );
    RAISE EXCEPTION 'TESTE FALHOU: origem aceitou outro campo';
  EXCEPTION
    WHEN foreign_key_violation THEN
      NULL;
  END;

  BEGIN
    INSERT INTO public.project_comments (
      id, project_id, author_id, body, source_field_review_id
    ) VALUES (
      '47100000-0000-0000-0000-000000000004',
      '20000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000001',
      'Contexto ausente',
      '43000000-0000-0000-0000-000000000001'
    );
    RAISE EXCEPTION 'TESTE FALHOU: origem automática aceitou contexto NULL';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  RAISE NOTICE 'OK: proveniência automática fixa projeto, documento e campo';
END;
$$;

-- ========== Constraints ==========
DO $$
DECLARE
  n integer;
  malformed_email text;
BEGIN
  FOREACH malformed_email IN ARRAY ARRAY[
    '',
    ' Alias@Example.Test ',
    'Alias@example.test'
  ] LOOP
    BEGIN
      INSERT INTO public.member_email_links
        (project_id, member_user_id, email, created_by)
      VALUES
        ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', malformed_email, '10000000-0000-0000-0000-000000000001');
      RAISE EXCEPTION 'TESTE FALHOU: e-mail não canônico foi aceito: %', malformed_email;
    EXCEPTION
      WHEN check_violation THEN
        NULL;
    END;
  END LOOP;

  BEGIN
    UPDATE public.member_email_links
    SET email = 'ALIAS-RESEARCHER@EXAMPLE.TEST'
    WHERE id = '30000000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'TESTE FALHOU: UPDATE criou e-mail não canônico';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'OK: e-mail de alias é canônico em INSERT e UPDATE';
  END;

  BEGIN
    INSERT INTO public.member_email_links
      (project_id, member_user_id, email, linked_user_id, created_by)
    VALUES
      ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'member-cannot-be-alias@example.test', '10000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'TESTE FALHOU: membership existente virou alias';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'OK: membership terminal não pode virar alias';
  END;

  BEGIN
    INSERT INTO public.project_members
      (project_id, user_id, role, can_resolve)
    VALUES
      ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003', 'pesquisador', false);
    RAISE EXCEPTION 'TESTE FALHOU: alias existente recebeu membership';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'OK: alias terminal não pode receber membership';
  END;

  INSERT INTO public.member_email_links
    (id, project_id, member_user_id, email, linked_user_id, created_by)
  VALUES
    ('30000000-0000-0000-0000-000000000008', '20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'second-email-same-account@example.test', '10000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001');

  PERFORM pg_catalog.set_config(
    'request.jwt.claims',
    '{"sub":"10000000-0000-0000-0000-000000000003","supabase_uid":"10000000-0000-0000-0000-000000000003"}',
    true
  );
  SELECT count(*) INTO n
  FROM public.auth_user_project_memberships() membership
  WHERE membership.project_id = '20000000-0000-0000-0000-000000000001';
  PERFORM pg_catalog.set_config('request.jwt.claims', '{}', true);
  IF n <> 1 THEN
    RAISE EXCEPTION
      'FALHOU identidade: dois e-mails do mesmo target produziram % memberships', n;
  END IF;

  BEGIN
    INSERT INTO public.member_email_links
      (project_id, member_user_id, email, linked_user_id, created_by)
    VALUES
      ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000004', 'same-account-other-target@example.test', '10000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION
      'TESTE FALHOU: a mesma conta resolveu para targets distintos';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE
        'OK: vários e-mails convergem ao mesmo target, nunca a targets distintos';
  END;

  DELETE FROM public.member_email_links
  WHERE id = '30000000-0000-0000-0000-000000000008';

  BEGIN
    INSERT INTO public.member_email_links
      (project_id, member_user_id, email, linked_user_id, created_by)
    VALUES
      ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'self-alias@example.test', '10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'TESTE FALHOU: self-alias foi aceito';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'OK: self-alias falhou com 23514';
  END;

  BEGIN
    INSERT INTO public.member_email_links
      (project_id, member_user_id, email, linked_user_id, created_by)
    VALUES
      ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000009', 'target-outside-project@example.test', NULL, '10000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'TESTE FALHOU: target fora de project_members foi aceito';
  EXCEPTION
    WHEN foreign_key_violation THEN
      RAISE NOTICE 'OK: target fora do projeto falhou com 23503';
  END;

  BEGIN
    INSERT INTO public.member_email_links
      (project_id, member_user_id, email, linked_user_id, created_by)
    VALUES
      ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000004', 'chain@example.test', '10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'TESTE FALHOU: cadeia de aliases foi aceita';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'OK: identidade canônica não pode virar alias intermediário';
  END;

  BEGIN
    INSERT INTO public.member_email_links
      (project_id, member_user_id, email, linked_user_id, created_by)
    VALUES
      ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003', 'cycle@example.test', '10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'TESTE FALHOU: ciclo de aliases foi aceito';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'OK: ciclo de aliases foi rejeitado';
  END;

  BEGIN
    UPDATE public.field_reviews
    SET arbitrator_id = self_reviewer_id
    WHERE id = '43000000-0000-0000-0000-000000000002';
    RAISE EXCEPTION 'TESTE FALHOU: autoarbitragem pendente foi aceita';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'OK: constraint rejeita autoarbitragem pendente';
  END;
END;
$$;

INSERT INTO public.project_comments
  (id, project_id, document_id, field_name, author_id, body, source_field_review_id)
VALUES
  ('47000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'campo', '10000000-0000-0000-0000-000000000001', 'Efeito automático único', '43000000-0000-0000-0000-000000000001');

DO $$
BEGIN
  BEGIN
    INSERT INTO public.project_comments
      (id, project_id, document_id, field_name, author_id, body, source_field_review_id)
    VALUES
      ('47000000-0000-0000-0000-000000000006', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'campo', '10000000-0000-0000-0000-000000000001', 'Retry concorrente do mesmo efeito', '43000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION
      'TESTE FALHOU: segunda proveniência da mesma revisão foi aceita';
  EXCEPTION
    WHEN unique_violation THEN
      RAISE NOTICE
        'OK: source_field_review_id fecha efeitos duplicados';
  END;
END;
$$;

INSERT INTO public.project_comments
  (id, project_id, author_id, body, source_field_review_id)
VALUES
  ('47000000-0000-0000-0000-000000000006', '20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Comentário manual repetível', NULL),
  ('47000000-0000-0000-0000-000000000007', '20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Comentário manual repetível', NULL);

DO $$
BEGIN
  RAISE NOTICE
    'OK: origem NULL permite comentários manuais repetidos';
END;
$$;

-- Excluir um documento remove seu comentário automático antes de o FK legado
-- tentar aplicar SET NULL, enquanto comentários manuais continuam preservados.
INSERT INTO public.documents (id, project_id, title, text)
VALUES (
  '40000000-0000-0000-0000-00000000000d',
  '20000000-0000-0000-0000-000000000001',
  'Documento para cascade de comentários',
  'texto descartável'
);

INSERT INTO public.responses
  (id, project_id, document_id, respondent_id, respondent_type, answers)
VALUES
  (
    '42000000-0000-0000-0000-00000000000d',
    '20000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-00000000000d',
    '10000000-0000-0000-0000-000000000002',
    'humano',
    '{}'
  ),
  (
    '42000000-0000-0000-0000-00000000000e',
    '20000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-00000000000d',
    NULL,
    'llm',
    '{}'
  );

INSERT INTO public.field_reviews (
  id,
  project_id,
  document_id,
  field_name,
  human_response_id,
  llm_response_id,
  self_reviewer_id
) VALUES (
  '43000000-0000-0000-0000-00000000000d',
  '20000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-00000000000d',
  'campo-cascade',
  '42000000-0000-0000-0000-00000000000d',
  '42000000-0000-0000-0000-00000000000e',
  '10000000-0000-0000-0000-000000000002'
);

INSERT INTO public.project_comments (
  id,
  project_id,
  document_id,
  field_name,
  author_id,
  body,
  source_field_review_id
) VALUES
  (
    '47000000-0000-0000-0000-00000000000d',
    '20000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-00000000000d',
    'campo-cascade',
    '10000000-0000-0000-0000-000000000001',
    'Comentário automático descartável',
    '43000000-0000-0000-0000-00000000000d'
  ),
  (
    '47000000-0000-0000-0000-00000000000e',
    '20000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-00000000000d',
    'campo-manual',
    '10000000-0000-0000-0000-000000000001',
    'Comentário manual preservado',
    NULL
  );

DELETE FROM public.documents
WHERE id = '40000000-0000-0000-0000-00000000000d';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.project_comments
    WHERE id = '47000000-0000-0000-0000-00000000000d'
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.project_comments
    WHERE id = '47000000-0000-0000-0000-00000000000e'
      AND document_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'FALHOU cascade: comentário automático não saiu ou manual não foi preservado';
  END IF;

  RAISE NOTICE
    'OK: excluir documento remove comentário automático e preserva o manual';
END;
$$;

-- Várias contas podem apontar diretamente para o mesmo target terminal.
INSERT INTO public.member_email_links
  (id, project_id, member_user_id, email, linked_user_id, created_by)
VALUES
  ('30000000-0000-0000-0000-000000000007', '20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'second-alias-same-target@example.test', '10000000-0000-0000-0000-00000000000f', '10000000-0000-0000-0000-000000000001');

DO $$
BEGIN
  BEGIN
    UPDATE public.member_email_links
    SET member_user_id = '10000000-0000-0000-0000-000000000003'
    WHERE id = '30000000-0000-0000-0000-000000000007';
    RAISE EXCEPTION 'TESTE FALHOU: UPDATE criou uma cadeia de aliases';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'OK: UPDATE também preserva targets terminais';
  END;
END;
$$;

DELETE FROM public.member_email_links
WHERE id = '30000000-0000-0000-0000-000000000007';

-- O mesmo linked_user em outro projeto é válido: a identidade é por projeto.
INSERT INTO public.member_email_links
  (id, project_id, member_user_id, email, linked_user_id, created_by)
VALUES
  ('30000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000009', 'same-account-other-project@example.test', '10000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000009');

-- Mesmo chamadas diretas das RPCs precisam revalidar o estado completo. A
-- aplicação filtra o pool; a transação é o backstop da mesma invariante.
UPDATE public.project_members
SET can_arbitrate = true,
    can_compare = true
WHERE project_id = '20000000-0000-0000-0000-000000000001'
  AND user_id IN (
    '10000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000006',
    '10000000-0000-0000-0000-000000000008'
  );

-- Resposta histórica não torna o autor codificador vigente do documento.
INSERT INTO public.responses
  (id, project_id, document_id, respondent_id, respondent_type, answers,
   is_latest)
VALUES
  ('42000000-0000-0000-0000-000000000007', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000006', 'humano', '{"campo":"histórica"}', false);

-- O sorteio manual continua aceitando vários revisores no mesmo documento.
INSERT INTO public.assignments
  (id, project_id, document_id, user_id, status, type)
VALUES
  ('41000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000006', 'pendente', 'comparacao'),
  ('41000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000008', 'pendente', 'comparacao');

DO $$
BEGIN
  BEGIN
    INSERT INTO public.responses
      (project_id, document_id, respondent_id, respondent_type, answers)
    VALUES
      ('20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000006', 'humano', '{"campo":"autoavaliação"}');
    RAISE EXCEPTION
      'TESTE FALHOU: revisor de comparação codificou o mesmo documento';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  BEGIN
    INSERT INTO public.assignments
      (project_id, document_id, user_id, status, type)
    VALUES
      ('20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000008', 'pendente', 'comparacao');
    RAISE EXCEPTION
      'TESTE FALHOU: codificador recebeu a própria comparação';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  RAISE NOTICE 'OK: invariante comparison é bilateral';
END;
$$;

DO $$
DECLARE
  assigned integer;
  synced boolean;
BEGIN
  PERFORM pg_catalog.set_config('request.jwt.claims', '{}', true);

  SELECT public.assign_arbitration_if_eligible(
    '20000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000008',
    ARRAY['campo']
  ) INTO assigned;

  IF assigned <> 0 OR EXISTS (
    SELECT 1 FROM public.field_reviews
    WHERE id = '43000000-0000-0000-0000-000000000002'
      AND arbitrator_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'FALHOU RPC: auto-revisor foi atribuído como árbitro';
  END IF;

  SELECT public.assign_arbitration_if_eligible(
    '20000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000006',
    ARRAY['campo']
  ) INTO assigned;
  IF assigned <> 0 THEN
    RAISE EXCEPTION 'FALHOU RPC: linha sem contestação recebeu árbitro';
  END IF;

  UPDATE public.field_reviews
  SET self_verdict = 'contesta_llm',
      self_reviewed_at = now(),
      arbitrator_id = '10000000-0000-0000-0000-000000000004',
      blind_verdict = 'humano',
      blind_decided_at = now(),
      final_verdict = 'humano',
      final_decided_at = now()
  WHERE id = '43000000-0000-0000-0000-000000000002';

  SELECT public.assign_arbitration_if_eligible(
    '20000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000006',
    ARRAY['campo']
  ) INTO assigned;
  IF assigned <> 0 THEN
    RAISE EXCEPTION 'FALHOU RPC: linha concluída recebeu árbitro';
  END IF;

  UPDATE public.field_reviews
  SET arbitrator_id = NULL,
      blind_verdict = NULL,
      blind_decided_at = NULL,
      final_verdict = NULL,
      final_decided_at = NULL
  WHERE id = '43000000-0000-0000-0000-000000000002';

  SELECT public.assign_arbitration_if_eligible(
    '20000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000006',
    ARRAY['campo']
  ) INTO assigned;
  IF assigned <> 1 OR NOT EXISTS (
    SELECT 1 FROM public.field_reviews
    WHERE id = '43000000-0000-0000-0000-000000000002'
      AND arbitrator_id = '10000000-0000-0000-0000-000000000006'
  ) THEN
    RAISE EXCEPTION 'FALHOU RPC: contestação pendente elegível não foi atribuída';
  END IF;

  PERFORM pg_catalog.set_config(
    'request.jwt.claims',
    '{"sub":"10000000-0000-0000-0000-000000000006","supabase_uid":"10000000-0000-0000-0000-000000000006"}',
    true
  );

  SELECT public.sync_arbitration_assignment_status(
    '20000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000006'
  ) INTO synced;

  IF synced OR NOT EXISTS (
    SELECT 1
    FROM public.assignments
    WHERE document_id = '40000000-0000-0000-0000-000000000002'
      AND user_id = '10000000-0000-0000-0000-000000000006'
      AND type = 'arbitragem'
      AND status = 'pendente'
  ) THEN
    RAISE EXCEPTION 'FALHOU RPC: sync fechou arbitragem ainda pendente';
  END IF;

  UPDATE public.field_reviews
  SET blind_verdict = 'humano',
      blind_decided_at = now()
  WHERE id = '43000000-0000-0000-0000-000000000002';

  UPDATE public.field_reviews
  SET final_verdict = 'humano',
      final_decided_at = now()
  WHERE id = '43000000-0000-0000-0000-000000000002';

  SELECT public.sync_arbitration_assignment_status(
    '20000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000006'
  ) INTO synced;

  IF NOT synced THEN
    RAISE EXCEPTION 'FALHOU RPC: sync retornou false sem pendências';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.assignments
    WHERE document_id = '40000000-0000-0000-0000-000000000002'
      AND user_id = '10000000-0000-0000-0000-000000000006'
      AND type = 'arbitragem'
      AND status = 'concluido'
      AND completed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'FALHOU RPC: sync não persistiu assignment concluído';
  END IF;

  PERFORM pg_catalog.set_config('request.jwt.claims', '{}', true);

  UPDATE public.field_reviews
  SET arbitrator_id = NULL,
      blind_verdict = NULL,
      blind_decided_at = NULL,
      final_verdict = NULL,
      final_decided_at = NULL
  WHERE id = '43000000-0000-0000-0000-000000000002';

  SELECT public.assign_arbitration_if_eligible(
    '20000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000006',
    ARRAY['campo']
  ) INTO assigned;
  IF assigned <> 1 OR NOT EXISTS (
    SELECT 1
    FROM public.assignments
    WHERE document_id = '40000000-0000-0000-0000-000000000002'
      AND user_id = '10000000-0000-0000-0000-000000000006'
      AND type = 'arbitragem'
      AND status = 'pendente'
      AND completed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'FALHOU RPC: nova arbitragem não reabriu assignment';
  END IF;

  PERFORM pg_catalog.set_config('request.jwt.claims', '{}', true);

  IF public.assign_comparison_if_eligible(
    '20000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000008'
  ) THEN
    RAISE EXCEPTION 'FALHOU RPC: codificador foi atribuído à própria comparação';
  END IF;

  IF NOT public.assign_comparison_if_eligible(
    '20000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000006'
  ) THEN
    RAISE EXCEPTION 'FALHOU RPC: resposta apenas histórica bloqueou comparação';
  END IF;

  IF public.assign_comparison_if_eligible(
    '20000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000002'
  ) OR (
    SELECT count(*)
    FROM public.assignments
    WHERE project_id = '20000000-0000-0000-0000-000000000001'
      AND document_id = '40000000-0000-0000-0000-000000000002'
      AND type = 'comparacao'
      AND status <> 'concluido'
  ) <> 1 THEN
    RAISE EXCEPTION 'FALHOU RPC: auto-sorteio criou segunda comparação ativa';
  END IF;

  RAISE NOTICE 'OK: RPCs validam estado, autoria vigente e auto-sorteio único';
END;
$$;

SELECT pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000006","supabase_uid":"10000000-0000-0000-0000-000000000006"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  synced boolean;
BEGIN
  SELECT public.sync_arbitration_assignment_status(
    '20000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000006'
  ) INTO synced;
  IF synced THEN
    RAISE EXCEPTION 'FALHOU RPC: árbitro fechou fila ainda pendente';
  END IF;

  BEGIN
    PERFORM public.sync_arbitration_assignment_status(
      '20000000-0000-0000-0000-000000000001',
      '40000000-0000-0000-0000-000000000002',
      '10000000-0000-0000-0000-000000000002'
    );
    RAISE EXCEPTION 'FALHOU RPC: árbitro sincronizou fila alheia';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;

  UPDATE public.field_reviews
  SET blind_verdict = 'humano'
  WHERE id = '43000000-0000-0000-0000-000000000002';

  UPDATE public.field_reviews
  SET final_verdict = 'humano'
  WHERE id = '43000000-0000-0000-0000-000000000002';

  SELECT public.sync_arbitration_assignment_status(
    '20000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000006'
  ) INTO synced;
  IF NOT synced OR NOT EXISTS (
    SELECT 1
    FROM public.assignments
    WHERE project_id = '20000000-0000-0000-0000-000000000001'
      AND document_id = '40000000-0000-0000-0000-000000000002'
      AND user_id = '10000000-0000-0000-0000-000000000006'
      AND type = 'arbitragem'
      AND status = 'concluido'
      AND completed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'FALHOU RPC: árbitro autenticado não concluiu a própria fila';
  END IF;

  RAISE NOTICE 'OK: árbitro autenticado sincroniza somente a própria fila canônica';
END;
$$;

RESET ROLE;
SELECT pg_catalog.set_config('request.jwt.claims', '{}', true);

UPDATE public.field_reviews
SET arbitrator_id = NULL,
    blind_verdict = NULL,
    blind_decided_at = NULL,
    final_verdict = NULL,
    final_decided_at = NULL
WHERE id = '43000000-0000-0000-0000-000000000002';

UPDATE public.project_members
SET can_arbitrate = false,
    can_compare = false
WHERE project_id = '20000000-0000-0000-0000-000000000001'
  AND user_id IN (
    '10000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000006',
    '10000000-0000-0000-0000-000000000008'
  );

-- ========== RPC de unificação sob a nova unicidade ==========
-- Source e target em lados opostos de uma arbitragem aberta não podem virar a
-- mesma identidade. A operação aborta antes de migrar qualquer trabalho.
UPDATE public.field_reviews
SET self_reviewer_id = '10000000-0000-0000-0000-00000000000e',
    self_verdict = 'contesta_llm',
    self_reviewed_at = now(),
    arbitrator_id = '10000000-0000-0000-0000-000000000004'
WHERE id = '43000000-0000-0000-0000-000000000002';

DO $$
BEGIN
  BEGIN
    PERFORM public.unify_project_members(
      '20000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-00000000000e',
      '10000000-0000-0000-0000-000000000004',
      '10000000-0000-0000-0000-00000000000e',
      'unify-source@example.test',
      '10000000-0000-0000-0000-000000000001',
      0
    );
    RAISE EXCEPTION 'TESTE FALHOU: unificação criou autoarbitragem pendente';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM public.project_members
    WHERE project_id = '20000000-0000-0000-0000-000000000001'
      AND user_id = '10000000-0000-0000-0000-00000000000e'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.field_reviews
    WHERE id = '43000000-0000-0000-0000-000000000002'
      AND self_reviewer_id = '10000000-0000-0000-0000-00000000000e'
      AND arbitrator_id = '10000000-0000-0000-0000-000000000004'
  ) THEN
    RAISE EXCEPTION 'FALHOU RPC: autoarbitragem alterou estado antes de abortar';
  END IF;
  RAISE NOTICE 'OK: unificação aborta diante de arbitragem pendente entre as identidades';
END;
$$;

UPDATE public.field_reviews
SET self_reviewer_id = '10000000-0000-0000-0000-00000000000e',
    self_verdict = NULL,
    self_justification = NULL,
    self_reviewed_at = NULL,
    arbitrator_id = NULL,
    blind_verdict = NULL,
    blind_decided_at = NULL
WHERE id = '43000000-0000-0000-0000-000000000002';

-- A unificação também é bloqueada quando fundiria o autor de uma resposta com
-- um revisor ativo da mesma comparação. Preview e execução usam o mesmo dado.
INSERT INTO public.responses
  (id, project_id, document_id, respondent_id, respondent_type, answers)
VALUES
  ('42000000-0000-0000-0000-000000000008', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-00000000000e', 'humano', '{"campo":"source"}');

INSERT INTO public.assignments
  (id, project_id, document_id, user_id, status, type)
VALUES
  ('41000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000004', 'pendente', 'comparacao');

DO $$
DECLARE
  conflicts bigint;
BEGIN
  SELECT preview.comparison_conflicts
  INTO STRICT conflicts
  FROM public.preview_project_member_unification(
    '20000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-00000000000e',
    '10000000-0000-0000-0000-000000000004'
  ) preview;
  IF conflicts <> 1 THEN
    RAISE EXCEPTION 'FALHOU preview: esperava 1 comparação conflitante, viu %', conflicts;
  END IF;

  BEGIN
    PERFORM public.unify_project_members(
      '20000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-00000000000e',
      '10000000-0000-0000-0000-000000000004',
      '10000000-0000-0000-0000-00000000000e',
      'unify-source@example.test',
      '10000000-0000-0000-0000-000000000001',
      0
    );
    RAISE EXCEPTION 'TESTE FALHOU: unificação criou autocomparação';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  RAISE NOTICE 'OK: preview e unificação bloqueiam conflito de comparação';
END;
$$;

DELETE FROM public.assignments
WHERE id = '41000000-0000-0000-0000-000000000005';

-- Reviews concorrentes do mesmo campo são dados distintos. A unificação deve
-- abortar sem escolher uma delas nem apagar histórico.
INSERT INTO public.reviews
  (id, project_id, document_id, field_name, reviewer_id, verdict)
VALUES
  ('44000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'campo', '10000000-0000-0000-0000-000000000004', 'llm');

DO $$
DECLARE
  n integer;
BEGIN
  BEGIN
    PERFORM public.unify_project_members(
      '20000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-00000000000e',
      '10000000-0000-0000-0000-000000000004',
      '10000000-0000-0000-0000-00000000000e',
      'unify-source@example.test',
      '10000000-0000-0000-0000-000000000001',
      0
    );
    RAISE EXCEPTION 'TESTE FALHOU: unificação descartou uma review em colisão';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  SELECT count(*) INTO n
  FROM public.reviews
  WHERE id IN (
    '44000000-0000-0000-0000-000000000003',
    '44000000-0000-0000-0000-000000000004'
  );

  IF n <> 2 OR NOT EXISTS (
    SELECT 1 FROM public.reviews
    WHERE id = '44000000-0000-0000-0000-000000000003'
      AND reviewer_id = '10000000-0000-0000-0000-00000000000e'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.reviews
    WHERE id = '44000000-0000-0000-0000-000000000004'
      AND reviewer_id = '10000000-0000-0000-0000-000000000004'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.project_members
    WHERE project_id = '20000000-0000-0000-0000-000000000001'
      AND user_id = '10000000-0000-0000-0000-00000000000e'
  ) THEN
    RAISE EXCEPTION 'FALHOU RPC: colisão de reviews não fez rollback integral';
  END IF;

  RAISE NOTICE 'OK: colisão de reviews aborta sem perder nenhuma linha';
END;
$$;

DELETE FROM public.reviews
WHERE id = '44000000-0000-0000-0000-000000000004';

-- Cobertura integral das tabelas tocadas pela unificação. Há uma colisão de
-- assignment em que o target prevalece, outra linha que precisa migrar, duas
-- respostas latest que precisam convergir e autoria histórica que deve ficar
-- associada à conta bruta.
INSERT INTO public.assignments
  (id, project_id, document_id, user_id, status, type, completed_at)
VALUES
  ('41000000-0000-0000-0000-000000000010', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-00000000000e', 'em_andamento', 'codificacao', NULL),
  ('41000000-0000-0000-0000-000000000011', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000004', 'concluido', 'codificacao', '2001-01-01T00:00:00Z'),
  ('41000000-0000-0000-0000-000000000012', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-00000000000e', 'pendente', 'auto_revisao', NULL);

UPDATE public.responses
SET created_at = '2000-01-01T00:00:00Z',
    updated_at = '2000-01-01T00:00:00Z'
WHERE id = '42000000-0000-0000-0000-000000000008';

INSERT INTO public.responses
  (id, project_id, document_id, respondent_id, respondent_type, answers)
VALUES
  ('42000000-0000-0000-0000-000000000009', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000004', 'humano', '{"campo":"target"}');

INSERT INTO public.verdict_acknowledgments
  (id, review_id, respondent_id, status)
VALUES
  ('45000000-0000-0000-0000-000000000003', '44000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-00000000000e', 'accepted'),
  ('45000000-0000-0000-0000-000000000004', '44000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000004', 'pending');

INSERT INTO public.response_equivalences
  (id, project_id, document_id, field_name, response_a_id, response_b_id,
   reviewer_id)
VALUES
  ('46000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000002', 'unification', '42000000-0000-0000-0000-000000000003', '42000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-00000000000e');

INSERT INTO public.researcher_field_orders
  (project_id, user_id, field_order)
VALUES
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-00000000000e', '["source-only"]');

INSERT INTO public.member_email_links
  (id, project_id, member_user_id, email, linked_user_id, created_by)
VALUES
  ('30000000-0000-0000-0000-000000000008', '20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-00000000000e', 'unify-secondary@example.test', '10000000-0000-0000-0000-00000000000f', '10000000-0000-0000-0000-000000000001');

UPDATE public.field_reviews
SET arbitrator_id = '10000000-0000-0000-0000-00000000000e'
WHERE id = '43000000-0000-0000-0000-000000000001';

UPDATE public.reviews
SET resolved_by = '10000000-0000-0000-0000-00000000000e'
WHERE id = '44000000-0000-0000-0000-000000000003';
UPDATE public.project_comments
SET author_id = '10000000-0000-0000-0000-00000000000e',
    resolved_by = '10000000-0000-0000-0000-00000000000e'
WHERE id = '47000000-0000-0000-0000-000000000003';
UPDATE public.difficulty_resolutions
SET resolved_by = '10000000-0000-0000-0000-00000000000e'
WHERE id = '49000000-0000-0000-0000-000000000001';
UPDATE public.error_resolutions
SET resolved_by = '10000000-0000-0000-0000-00000000000e'
WHERE id = '49000000-0000-0000-0000-000000000002';
UPDATE public.note_resolutions
SET resolved_by = '10000000-0000-0000-0000-00000000000e'
WHERE id = '49000000-0000-0000-0000-000000000003';
UPDATE public.assignment_batches
SET created_by = '10000000-0000-0000-0000-00000000000e'
WHERE id = '4a000000-0000-0000-0000-000000000001';

-- Source e target são memberships terminais. A RPC migra o trabalho, remove
-- a membership source e só então registra o novo alias permanente.
SELECT public.unify_project_members(
  '20000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-00000000000e',
  '10000000-0000-0000-0000-000000000004',
  '10000000-0000-0000-0000-00000000000e',
  'unify-source@example.test',
  '10000000-0000-0000-0000-000000000001',
  0
);

DO $$
DECLARE
  n integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.project_members
    WHERE project_id = '20000000-0000-0000-0000-000000000001'
      AND user_id = '10000000-0000-0000-0000-00000000000e'
  ) THEN
    RAISE EXCEPTION 'FALHOU RPC: membership source não foi removida';
  END IF;

  SELECT count(*) INTO n FROM public.member_email_links
  WHERE project_id = '20000000-0000-0000-0000-000000000001'
    AND linked_user_id = '10000000-0000-0000-0000-00000000000e'
    AND member_user_id = '10000000-0000-0000-0000-000000000004';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALHOU RPC: esperava criar 1 alias, encontrou %', n;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.member_email_links
    WHERE id = '30000000-0000-0000-0000-000000000008'
      AND member_user_id = '10000000-0000-0000-0000-000000000004'
      AND linked_user_id = '10000000-0000-0000-0000-00000000000f'
  ) THEN
    RAISE EXCEPTION 'FALHOU RPC: alias secundário não migrou para o target';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.assignments
    WHERE project_id = '20000000-0000-0000-0000-000000000001'
      AND user_id = '10000000-0000-0000-0000-00000000000e'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.assignments
    WHERE id = '41000000-0000-0000-0000-000000000011'
      AND user_id = '10000000-0000-0000-0000-000000000004'
      AND status = 'concluido'
      AND completed_at = '2001-01-01T00:00:00Z'::timestamptz
  ) OR NOT EXISTS (
    SELECT 1 FROM public.assignments
    WHERE id = '41000000-0000-0000-0000-000000000012'
      AND user_id = '10000000-0000-0000-0000-000000000004'
      AND status = 'pendente'
  ) OR EXISTS (
    SELECT 1 FROM public.assignments
    WHERE id = '41000000-0000-0000-0000-000000000010'
  ) THEN
    RAISE EXCEPTION 'FALHOU RPC: assignments não migraram com precedência do target';
  END IF;

  IF (
    SELECT count(*)
    FROM public.responses
    WHERE id IN (
      '42000000-0000-0000-0000-000000000008',
      '42000000-0000-0000-0000-000000000009'
    )
      AND respondent_id = '10000000-0000-0000-0000-000000000004'
  ) <> 2 OR (
    SELECT count(*)
    FROM public.responses
    WHERE id IN (
      '42000000-0000-0000-0000-000000000008',
      '42000000-0000-0000-0000-000000000009'
    )
      AND is_latest
  ) <> 1 OR NOT EXISTS (
    SELECT 1 FROM public.responses
    WHERE id = '42000000-0000-0000-0000-000000000009'
      AND is_latest
  ) THEN
    RAISE EXCEPTION 'FALHOU RPC: responses não convergiram para um único latest';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.reviews
    WHERE id = '44000000-0000-0000-0000-000000000003'
      AND reviewer_id = '10000000-0000-0000-0000-000000000004'
  ) OR EXISTS (
    SELECT 1 FROM public.verdict_acknowledgments
    WHERE id = '45000000-0000-0000-0000-000000000003'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.verdict_acknowledgments
    WHERE id = '45000000-0000-0000-0000-000000000004'
      AND respondent_id = '10000000-0000-0000-0000-000000000004'
      AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'FALHOU RPC: review ou acknowledgment não convergiu com precedência do target';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.field_reviews
    WHERE id = '43000000-0000-0000-0000-000000000001'
      AND arbitrator_id = '10000000-0000-0000-0000-000000000004'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.field_reviews
    WHERE id = '43000000-0000-0000-0000-000000000002'
      AND self_reviewer_id = '10000000-0000-0000-0000-000000000004'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.response_equivalences
    WHERE id = '46000000-0000-0000-0000-000000000003'
      AND reviewer_id = '10000000-0000-0000-0000-000000000004'
  ) OR EXISTS (
    SELECT 1 FROM public.researcher_field_orders
    WHERE project_id = '20000000-0000-0000-0000-000000000001'
      AND user_id = '10000000-0000-0000-0000-00000000000e'
  ) THEN
    RAISE EXCEPTION 'FALHOU RPC: fases, equivalências ou preferência pessoal não migraram corretamente';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.responses
    WHERE project_id = '20000000-0000-0000-0000-000000000001'
      AND respondent_id = '10000000-0000-0000-0000-00000000000e'
    UNION ALL
    SELECT 1 FROM public.reviews
    WHERE project_id = '20000000-0000-0000-0000-000000000001'
      AND reviewer_id = '10000000-0000-0000-0000-00000000000e'
    UNION ALL
    SELECT 1 FROM public.field_reviews
    WHERE project_id = '20000000-0000-0000-0000-000000000001'
      AND (
        self_reviewer_id = '10000000-0000-0000-0000-00000000000e'
        OR arbitrator_id = '10000000-0000-0000-0000-00000000000e'
      )
    UNION ALL
    SELECT 1 FROM public.response_equivalences
    WHERE project_id = '20000000-0000-0000-0000-000000000001'
      AND reviewer_id = '10000000-0000-0000-0000-00000000000e'
  ) THEN
    RAISE EXCEPTION 'FALHOU RPC: identidade source permaneceu em coluna de trabalho';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.reviews
    WHERE id = '44000000-0000-0000-0000-000000000003'
      AND reviewer_id = '10000000-0000-0000-0000-000000000004'
      AND resolved_by = '10000000-0000-0000-0000-00000000000e'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.project_comments
    WHERE id = '47000000-0000-0000-0000-000000000003'
      AND author_id = '10000000-0000-0000-0000-00000000000e'
      AND resolved_by = '10000000-0000-0000-0000-00000000000e'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.difficulty_resolutions
    WHERE id = '49000000-0000-0000-0000-000000000001'
      AND resolved_by = '10000000-0000-0000-0000-00000000000e'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.error_resolutions
    WHERE id = '49000000-0000-0000-0000-000000000002'
      AND resolved_by = '10000000-0000-0000-0000-00000000000e'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.note_resolutions
    WHERE id = '49000000-0000-0000-0000-000000000003'
      AND resolved_by = '10000000-0000-0000-0000-00000000000e'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.assignment_batches
    WHERE id = '4a000000-0000-0000-0000-000000000001'
      AND created_by = '10000000-0000-0000-0000-00000000000e'
  ) THEN
    RAISE EXCEPTION 'FALHOU RPC: identidade de trabalho ou autoria histórica incorreta';
  END IF;

  RAISE NOTICE 'OK: RPC migra trabalho e preserva autoria/auditoria bruta';
END;
$$;

-- Colisão inesperada do e-mail principal deve reverter a RPC inteira. O link
-- pendente usa o e-mail do source, mas não está ligado à conta source.
INSERT INTO public.member_email_links
  (id, project_id, member_user_id, email, linked_user_id, created_by)
VALUES
  ('30000000-0000-0000-0000-000000000006', '20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000006', 'direct-member@example.test', NULL, '10000000-0000-0000-0000-000000000001');

DO $$
BEGIN
  BEGIN
    PERFORM public.unify_project_members(
      '20000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-00000000000b',
      '10000000-0000-0000-0000-000000000004',
      '10000000-0000-0000-0000-00000000000b',
      'direct-member@example.test',
      '10000000-0000-0000-0000-000000000001',
      0
    );
    RAISE EXCEPTION 'TESTE FALHOU: colisão de e-mail foi ignorada';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM public.project_members
    WHERE project_id = '20000000-0000-0000-0000-000000000001'
      AND user_id = '10000000-0000-0000-0000-00000000000b'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.member_email_links
    WHERE id = '30000000-0000-0000-0000-000000000006'
      AND linked_user_id IS NULL
  ) THEN
    RAISE EXCEPTION 'FALHOU RPC: colisão de e-mail não fez rollback integral';
  END IF;
  RAISE NOTICE 'OK: colisão de e-mail aborta e reverte a unificação';
END;
$$;

-- Excluir a membership canônica remove apenas os aliases daquele projeto.
DELETE FROM public.project_members
WHERE project_id = '20000000-0000-0000-0000-000000000001'
  AND user_id = '10000000-0000-0000-0000-000000000002';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.member_email_links
    WHERE id = '30000000-0000-0000-0000-000000000001'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.member_email_links
    WHERE id = '30000000-0000-0000-0000-000000000005'
  ) THEN
    RAISE EXCEPTION 'FALHOU cascade: alias errado removido ou preservado';
  END IF;
  RAISE NOTICE 'OK: FK composta faz cascade somente no projeto do target';
END;
$$;

-- ========== Contratos estruturais ==========
DO $$
DECLARE
  definition text;
  n integer;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition
  FROM pg_constraint
  WHERE conrelid = 'public.member_email_links'::regclass
    AND conname = 'member_email_links_project_member_fkey';
  IF definition NOT LIKE '%project_members(project_id, user_id)%ON DELETE CASCADE%' THEN
    RAISE EXCEPTION 'FALHOU contrato: FK composta/cascade ausente: %', definition;
  END IF;

  SELECT count(*) INTO n
  FROM pg_constraint
  WHERE conrelid = 'public.member_email_links'::regclass
    AND conname = 'member_email_links_member_user_id_fkey';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FALHOU contrato: FK simples redundante permanece';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO definition
  FROM pg_constraint
  WHERE conrelid = 'public.member_email_links'::regclass
    AND conname = 'member_email_links_email_canonical_check';
  IF definition IS NULL
     OR definition NOT ILIKE '%email <>%'
     OR definition NOT ILIKE '%lower(btrim(email))%'
  THEN
    RAISE EXCEPTION 'FALHOU contrato: e-mail de alias não é canônico';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO definition
  FROM pg_constraint
  WHERE conrelid = 'public.field_reviews'::regclass
    AND conname = 'field_reviews_pending_distinct_actors_check';
  IF definition NOT ILIKE '%final_verdict IS NOT NULL%'
     OR definition NOT ILIKE '%arbitrator_id <> self_reviewer_id%'
  THEN
    RAISE EXCEPTION
      'FALHOU contrato: autoarbitragem pendente não é irrepresentável';
  END IF;

  SELECT count(*) INTO n
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename = 'member_email_links'
    AND indexname = 'member_email_links_linked_user_project_idx'
    AND indexdef NOT LIKE '%UNIQUE INDEX%'
    AND indexdef LIKE '%linked_user_id, project_id%WHERE (linked_user_id IS NOT NULL)%';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALHOU contrato: índice parcial de resolução ausente';
  END IF;

  SELECT count(*) INTO n
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND indexname = 'idx_member_email_links_linked_user';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FALHOU contrato: índice simples redundante permanece';
  END IF;

  SELECT count(*) INTO n
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND indexname = 'assignments_one_active_comparison_per_document_key';
  IF n <> 0 THEN
    RAISE EXCEPTION
      'FALHOU contrato: auto-sorteio restringiu comparações manuais por índice';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO definition
  FROM pg_constraint
  WHERE conrelid = 'public.project_comments'::regclass
    AND conname = 'project_comments_source_field_review_id_key';
  IF definition IS NULL
     OR definition NOT ILIKE '%UNIQUE (source_field_review_id)%'
  THEN
    RAISE EXCEPTION
      'FALHOU contrato: unicidade da revisão de origem ausente';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO definition
  FROM pg_constraint
  WHERE conrelid = 'public.project_comments'::regclass
    AND conname = 'project_comments_source_field_review_id_fkey';
  IF definition IS NULL
     OR definition NOT ILIKE
       '%FOREIGN KEY (source_field_review_id, project_id, document_id, field_name) REFERENCES field_reviews(id, project_id, document_id, field_name) ON DELETE CASCADE%'
  THEN
    RAISE EXCEPTION
      'FALHOU contrato: proveniência não fixa projeto, documento e campo';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO definition
  FROM pg_constraint
  WHERE conrelid = 'public.project_comments'::regclass
    AND conname = 'project_comments_source_field_review_context_check';
  IF definition IS NULL
     OR definition NOT ILIKE '%source_field_review_id IS NULL%'
     OR definition NOT ILIKE '%document_id IS NOT NULL%'
     OR definition NOT ILIKE '%field_name IS NOT NULL%'
  THEN
    RAISE EXCEPTION
      'FALHOU contrato: origem automática aceita contexto incompleto';
  END IF;

  SELECT count(*) INTO n
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'profiles'
    AND policyname = 'Users and teammates view profiles'
    AND qual LIKE '%auth_user_accessible_project_ids%';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALHOU contrato: policy única de profiles não é alias-aware';
  END IF;

  SELECT count(*) INTO n
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'profiles'
    AND policyname = 'Project members view teammate profiles';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FALHOU contrato: policy residual de profiles permanece';
  END IF;

  SELECT count(*) INTO n
  FROM pg_policies
  WHERE schemaname = 'public'
    AND (
      coalesce(qual, '') LIKE '%project_members.user_id = clerk_uid()%'
      OR coalesce(with_check, '') LIKE '%project_members.user_id = clerk_uid()%'
    );
  IF n <> 0 THEN
    RAISE EXCEPTION
      'FALHOU contrato: % policies ainda resolvem membership pelo id bruto', n;
  END IF;

  SELECT pg_get_functiondef(
    'public.auth_user_project_memberships()'::regprocedure
  ) INTO definition;
  IF definition NOT ILIKE '%member_email_links%'
     OR definition NOT ILIKE '%project_members%'
  THEN
    RAISE EXCEPTION
      'FALHOU contrato: relação canônica não resolve identidade terminal';
  END IF;

  SELECT pg_get_functiondef(
    'public.auth_user_coordinator_project_ids()'::regprocedure
  ) INTO definition;
  IF definition NOT ILIKE '%auth_user_project_memberships%'
     OR definition NOT ILIKE '%role = ''coordenador''%'
  THEN
    RAISE EXCEPTION 'FALHOU contrato: coordenação não deriva da relação canônica';
  END IF;

  SELECT pg_get_functiondef(
    'public.auth_user_resolver_project_ids()'::regprocedure
  ) INTO definition;
  IF definition NOT ILIKE '%auth_user_project_memberships%'
     OR definition NOT ILIKE '%can_resolve%'
  THEN
    RAISE EXCEPTION 'FALHOU contrato: resolver não usa identidade canônica';
  END IF;

  SELECT pg_get_functiondef(
    'public.lock_project_identity_changes()'::regprocedure
  ) INTO definition;
  IF definition NOT ILIKE '%pg_advisory_xact_lock%'
     OR definition NOT ILIKE '%canonical-project-identity%'
  THEN
    RAISE EXCEPTION
      'FALHOU contrato: gestão de identidade não usa o lock global';
  END IF;

  SELECT count(*) INTO n
  FROM pg_trigger
  WHERE tgrelid = 'public.member_email_links'::regclass
    AND tgname = 'lock_member_email_links_identity_changes_trigger'
    AND NOT tgisinternal
    AND (tgtype & 1) = 0
    AND (tgtype & 2) = 2
    AND (tgtype & 4) = 4
    AND (tgtype & 16) = 16;
  IF n <> 1 THEN
    RAISE EXCEPTION
      'FALHOU contrato: member_email_links não toma lock antes do statement';
  END IF;

  SELECT count(*) INTO n
  FROM pg_trigger
  WHERE tgrelid = 'public.project_members'::regclass
    AND tgname = 'lock_project_members_identity_changes_trigger'
    AND NOT tgisinternal
    AND (tgtype & 1) = 0
    AND (tgtype & 2) = 2
    AND (tgtype & 4) = 4;
  IF n <> 1 THEN
    RAISE EXCEPTION
      'FALHOU contrato: project_members não toma lock antes do statement';
  END IF;

  SELECT pg_get_functiondef(
    'public.enforce_terminal_member_email_alias()'::regprocedure
  ) INTO definition;
  IF definition NOT ILIKE '%linked_user_id = new.member_user_id%'
     OR definition NOT ILIKE '%member_user_id = new.linked_user_id%'
     OR definition NOT ILIKE '%project_members%'
  THEN
    RAISE EXCEPTION
      'FALHOU contrato: aliases não permanecem terminais';
  END IF;

  SELECT pg_get_functiondef(
    'public.enforce_terminal_project_membership()'::regprocedure
  ) INTO definition;
  IF definition NOT ILIKE '%member_email_links%'
     OR definition NOT ILIKE '%project_id e user_id de uma membership são imutáveis%'
  THEN
    RAISE EXCEPTION
      'FALHOU contrato: membership pode coexistir com alias ou mudar identidade';
  END IF;

  SELECT pg_get_functiondef(
    'public.enforce_project_members_column_guard()'::regprocedure
  ) INTO definition;
  IF definition NOT ILIKE '%auth_user_member_identity_ids%'
     OR definition ILIKE '%old.user_id = public.clerk_uid()%'
  THEN
    RAISE EXCEPTION
      'FALHOU contrato: guard não usa exclusivamente a identidade canônica';
  END IF;

  SELECT pg_get_functiondef(
    'public.remove_project_member(uuid)'::regprocedure
  ) INTO definition;
  IF definition NOT ILIKE '%delete from public.project_members%'
     OR definition NOT ILIKE '%delete from public.assignments%'
     OR definition ILIKE '%delete from public.member_email_links%'
  THEN
    RAISE EXCEPTION
      'FALHOU contrato: remoção duplica ou omite responsabilidades da FK';
  END IF;

  SELECT pg_get_functiondef(
    'public.unify_project_members(uuid,uuid,uuid,uuid,text,uuid,bigint)'::regprocedure
  ) INTO definition;
  IF definition NOT ILIKE '%pg_advisory_xact_lock%'
     OR definition NOT ILIKE '%canonical-project-identity%'
     OR definition NOT ILIKE '%order by pm.user_id%'
     OR definition NOT ILIKE '%for update%'
     OR definition NOT ILIKE '%v_locked_membership_count <> 2%'
     OR definition NOT ILIKE '%lock table%'
     OR definition NOT ILIKE '%share row exclusive mode%'
     OR definition NOT ILIKE '%source e target participam da mesma arbitragem pendente%'
     OR definition NOT ILIKE '%source e target possuem revisões do mesmo campo%'
     OR definition ILIKE '%dataframeit.unifying_project_members%'
  THEN
    RAISE EXCEPTION
      'FALHOU contrato: unificação não fecha concorrência ou não preserva reviews';
  END IF;

  SELECT pg_get_functiondef(
    'public.assign_comparison_if_eligible(uuid,uuid,uuid)'::regprocedure
  ) INTO definition;
  IF definition NOT ILIKE '%lock table public.responses, public.assignments in row exclusive mode%'
     OR pg_catalog.strpos(definition, 'FROM public.project_members') = 0
     OR pg_catalog.strpos(definition, 'LOCK TABLE public.responses') = 0
     OR pg_catalog.strpos(definition, 'FROM public.project_members') >
        pg_catalog.strpos(definition, 'LOCK TABLE public.responses')
     OR definition ILIKE '%dataframeit.unifying_project_members%'
  THEN
    RAISE EXCEPTION
      'FALHOU contrato: comparison não segue membership→tabelas→advisory';
  END IF;

  SELECT pg_get_functiondef(
    'public.assign_arbitration_if_eligible(uuid,uuid,uuid,text[])'::regprocedure
  ) INTO definition;
  IF definition NOT ILIKE '%self_reviewer_id <> p_user_id%'
     OR definition NOT ILIKE '%can_arbitrate = true%'
     OR definition NOT ILIKE '%self_verdict = ''contesta_llm''%'
     OR definition NOT ILIKE '%final_verdict IS NULL%'
     OR definition NOT ILIKE '%lock_arbitration_assignment%'
     OR definition NOT ILIKE '%for update%'
  THEN
    RAISE EXCEPTION
      'FALHOU contrato: RPC de arbitragem não revalida elegibilidade e autoria';
  END IF;

  SELECT pg_get_functiondef(
    'public.sync_arbitration_assignment_status(uuid,uuid,uuid)'::regprocedure
  ) INTO definition;
  IF NOT (
       SELECT procedure.prosecdef
       FROM pg_catalog.pg_proc AS procedure
       WHERE procedure.oid =
         'public.sync_arbitration_assignment_status(uuid,uuid,uuid)'::regprocedure
     )
     OR definition NOT ILIKE '%auth_user_member_identity_ids%'
     OR definition NOT ILIKE '%lock_arbitration_assignment%'
     OR definition NOT ILIKE '%from public.project_members%'
     OR definition NOT ILIKE '%final_verdict IS NULL%'
     OR definition NOT ILIKE '%status = ''concluido''%'
     OR definition NOT ILIKE '%for update%'
  THEN
    RAISE EXCEPTION
      'FALHOU contrato: fechamento de arbitragem não é atômico com atribuição';
  END IF;

  SELECT pg_get_functiondef(
    'public.lock_arbitration_assignment(uuid,uuid,uuid)'::regprocedure
  ) INTO definition;
  IF definition NOT ILIKE '%pg_advisory_xact_lock%'
     OR definition NOT ILIKE '%arbitration-assignment:%'
  THEN
    RAISE EXCEPTION
      'FALHOU contrato: arbitragem não usa advisory compartilhado';
  END IF;

  SELECT pg_get_functiondef(
    'public.assign_comparison_if_eligible(uuid,uuid,uuid)'::regprocedure
  ) INTO definition;
  IF definition NOT ILIKE '%respondent_id = p_user_id%'
     OR definition NOT ILIKE '%is_latest = true%'
     OR definition NOT ILIKE '%can_compare = true%'
     OR definition NOT ILIKE '%lock_comparison_document%'
     OR definition NOT ILIKE '%status IS DISTINCT FROM ''concluido''%'
     OR definition NOT ILIKE '%for update%'
  THEN
    RAISE EXCEPTION
      'FALHOU contrato: RPC de comparação não revalida elegibilidade e autoria';
  END IF;

  SELECT pg_get_functiondef(
    'public.lock_comparison_document(uuid,uuid)'::regprocedure
  ) INTO definition;
  IF definition NOT ILIKE '%pg_advisory_xact_lock%'
     OR definition NOT ILIKE '%comparison:%'
  THEN
    RAISE EXCEPTION
      'FALHOU contrato: comparison não usa advisory compartilhado';
  END IF;

  SELECT pg_get_functiondef(
    'public.enforce_comparison_assignment_actor()'::regprocedure
  ) INTO definition;
  IF definition NOT ILIKE '%lock_comparison_document%'
     OR definition NOT ILIKE '%from public.responses%'
     OR definition NOT ILIKE '%respondent_type = ''humano''%'
     OR definition NOT ILIKE '%response.is_latest%'
     OR definition NOT ILIKE '%status IS NOT DISTINCT FROM ''concluido''%'
     OR definition ILIKE '%dataframeit.unifying_project_members%'
  THEN
    RAISE EXCEPTION
      'FALHOU contrato: trigger de assignment não inspeciona response ativa sob a trava comum';
  END IF;

  SELECT pg_get_functiondef(
    'public.enforce_comparison_response_actor()'::regprocedure
  ) INTO definition;
  IF definition NOT ILIKE '%lock_comparison_document%'
     OR definition NOT ILIKE '%from public.assignments%'
     OR definition NOT ILIKE '%assignment.type = ''comparacao''%'
     OR definition NOT ILIKE '%status IS DISTINCT FROM ''concluido''%'
     OR definition NOT ILIKE '%new.respondent_type <> ''humano''%'
     OR definition ILIKE '%dataframeit.unifying_project_members%'
  THEN
    RAISE EXCEPTION
      'FALHOU contrato: trigger de response não inspeciona assignment ativa sob a trava comum';
  END IF;

  SELECT count(*) INTO n
  FROM pg_trigger
  WHERE NOT tgisinternal
    AND (
      (
        tgrelid = 'public.assignments'::regclass
        AND tgname = 'enforce_comparison_assignment_actor_trigger'
      )
      OR (
        tgrelid = 'public.responses'::regclass
        AND tgname = 'enforce_comparison_response_actor_trigger'
      )
    );
  IF n <> 2 THEN
    RAISE EXCEPTION
      'FALHOU contrato: comparison não verifica os dois lados';
  END IF;

  RAISE NOTICE 'OK: constraints, índices, functions e policy final conferidos';
END;
$$;

-- ========== A prova de identidade é o único caminho de escrita ==========
-- A policy "Coordinators manage member_email_links" é FOR ALL sem WITH CHECK,
-- então a RLS sozinha liberaria o INSERT/UPDATE direto pelo PostgREST e um
-- coordenador vincularia qualquer conta como alias de qualquer membro sem
-- prova de posse do e-mail. Quem fecha isso é o REVOKE, não a policy.
--
-- O privilégio é interrogado com has_table_privilege em vez de tentar o INSERT
-- porque este ambiente não concede DML do schema public por padrão, ao
-- contrário do Supabase remoto: um INSERT recusado aqui passaria mesmo sem o
-- REVOKE, e o teste seria cego justamente ao caso de produção.
DO $$
BEGIN
  IF has_table_privilege(
    'authenticated', 'public.member_email_links', 'INSERT'
  ) THEN
    RAISE EXCEPTION
      'FALHOU prova de identidade: authenticated pode inserir alias direto';
  END IF;

  IF has_table_privilege(
    'authenticated', 'public.member_email_links', 'UPDATE'
  ) THEN
    RAISE EXCEPTION
      'FALHOU prova de identidade: authenticated pode alterar alias direto';
  END IF;

  IF has_table_privilege('anon', 'public.member_email_links', 'INSERT')
     OR has_table_privilege('anon', 'public.member_email_links', 'UPDATE')
  THEN
    RAISE EXCEPTION
      'FALHOU prova de identidade: anon pode gravar alias';
  END IF;

  -- A RPC é SECURITY DEFINER, então o REVOKE acima não a alcança: ela continua
  -- sendo o caminho legítimo de criação/alteração de vínculo.
  IF NOT has_function_privilege(
    'authenticated',
    'public.write_member_email_link_with_identity_proof'
      || '(UUID, UUID, TEXT, UUID, UUID, UUID, UUID, BIGINT)',
    'EXECUTE'
  ) AND NOT has_function_privilege(
    'service_role',
    'public.write_member_email_link_with_identity_proof'
      || '(UUID, UUID, TEXT, UUID, UUID, UUID, UUID, BIGINT)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION
      'FALHOU prova de identidade: nenhum role pode executar a RPC de vínculo';
  END IF;

  RAISE NOTICE 'OK: alias só nasce pela RPC de prova de identidade';
END;
$$;

ROLLBACK;
