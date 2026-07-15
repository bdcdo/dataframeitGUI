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
  ('10000000-0000-0000-0000-00000000000d', 'master@example.test');

UPDATE public.profiles
SET first_name = split_part(email, '@', 1);

INSERT INTO public.projects (id, name, created_by) VALUES
  ('20000000-0000-0000-0000-000000000001', 'Projeto canônico', '10000000-0000-0000-0000-000000000001'),
  ('20000000-0000-0000-0000-000000000002', 'Projeto isolado', '10000000-0000-0000-0000-000000000009'),
  ('20000000-0000-0000-0000-000000000003', 'Projeto apenas do criador', '10000000-0000-0000-0000-00000000000c');

INSERT INTO public.project_members
  (project_id, user_id, role, can_resolve)
VALUES
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'coordenador', false),
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'pesquisador', false),
  -- A membership bruta do alias tem privilégios maiores de propósito. A
  -- identidade canônica pesquisadora deve prevalecer e removê-los.
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003', 'coordenador', true),
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000004', 'coordenador', false),
  -- O inverso prova que papel do membro canônico também é herdado.
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000005', 'pesquisador', false),
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000006', 'pesquisador', true),
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000008', 'pesquisador', false),
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-00000000000b', 'pesquisador', false),
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
  ('44000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'campo', '10000000-0000-0000-0000-000000000005', 'humano');

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
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.verdict_acknowledgments, public.response_equivalences,
  public.researcher_field_orders
  TO authenticated;
GRANT INSERT, UPDATE
  ON public.project_comments, public.schema_suggestions
  TO authenticated;

-- ========== Alias de pesquisador: papel/flag brutos não vazam ==========
SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"10000000-0000-0000-0000-000000000003"}',
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
    RAISE EXCEPTION 'FALHOU precedência: papel coordenador bruto foi somado';
  END IF;

  SELECT count(*) INTO n FROM public.auth_user_resolver_project_ids();
  IF n <> 0 THEN
    RAISE EXCEPTION 'FALHOU precedência: can_resolve bruto foi somado';
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

  INSERT INTO public.project_comments
    (id, project_id, author_id, body)
  VALUES
    ('47000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003', 'Comentário do alias');

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

-- ========== Alias de coordenador: papel canônico libera viewAs ==========
SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"10000000-0000-0000-0000-000000000005"}',
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
    SET role = 'coordenador'
    WHERE project_id = '20000000-0000-0000-0000-000000000001'
      AND user_id = '10000000-0000-0000-0000-000000000005';
    RAISE EXCEPTION
      'TESTE FALHOU: alias coordenador alterou a própria membership bruta';
  EXCEPTION
    WHEN insufficient_privilege THEN
      IF SQLERRM <> 'Members cannot change their own role on project_members' THEN
        RAISE;
      END IF;
  END;

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
  '{"supabase_uid":"10000000-0000-0000-0000-000000000007"}',
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
  '{"supabase_uid":"10000000-0000-0000-0000-00000000000a"}',
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
  '{"supabase_uid":"10000000-0000-0000-0000-00000000000b"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
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
  '{"supabase_uid":"10000000-0000-0000-0000-00000000000c"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  member_projects integer;
  accessible_projects integer;
  managed_projects integer;
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
  RAISE NOTICE 'OK: ownership continua ligado à conta bruta';
END;
$$;

RESET ROLE;

-- ========== Master ==========
SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"10000000-0000-0000-0000-00000000000d"}',
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

-- ========== Constraints ==========
DO $$
BEGIN
  BEGIN
    INSERT INTO public.member_email_links
      (project_id, member_user_id, email, linked_user_id, created_by)
    VALUES
      ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'duplicate-account@example.test', '10000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'TESTE FALHOU: duplicata de linked_user no projeto foi aceita';
  EXCEPTION
    WHEN unique_violation THEN
      RAISE NOTICE 'OK: duplicata (linked_user_id, project_id) falhou com 23505';
  END;

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
END;
$$;

-- Várias contas podem apontar diretamente para o mesmo target terminal.
INSERT INTO public.member_email_links
  (id, project_id, member_user_id, email, linked_user_id, created_by)
VALUES
  ('30000000-0000-0000-0000-000000000007', '20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'second-alias-same-target@example.test', '10000000-0000-0000-0000-000000000008', '10000000-0000-0000-0000-000000000001');

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

-- ========== RPC de unificação sob a nova unicidade ==========
-- Alias source para outro target: falha antes de qualquer mutação.
DO $$
BEGIN
  BEGIN
    PERFORM public.unify_project_members(
      '20000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000003',
      '10000000-0000-0000-0000-000000000004',
      '10000000-0000-0000-0000-000000000001'
    );
    RAISE EXCEPTION 'TESTE FALHOU: unificação aceitou alias para outro target';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM public.project_members
    WHERE project_id = '20000000-0000-0000-0000-000000000001'
      AND user_id = '10000000-0000-0000-0000-000000000003'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.member_email_links
    WHERE id = '30000000-0000-0000-0000-000000000001'
      AND member_user_id = '10000000-0000-0000-0000-000000000002'
  ) THEN
    RAISE EXCEPTION 'FALHOU RPC: conflito alterou estado antes de abortar';
  END IF;
  RAISE NOTICE 'OK: RPC aborta conflito de target antes das mutações';
END;
$$;

-- Alias source já voltado ao target: reutiliza a linha e remove a membership
-- source sem tentar inserir uma segunda identidade.
SELECT public.unify_project_members(
  '20000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000005',
  '10000000-0000-0000-0000-000000000004',
  '10000000-0000-0000-0000-000000000001'
);

DO $$
DECLARE
  n integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.project_members
    WHERE project_id = '20000000-0000-0000-0000-000000000001'
      AND user_id = '10000000-0000-0000-0000-000000000005'
  ) THEN
    RAISE EXCEPTION 'FALHOU RPC: membership source não foi removida';
  END IF;

  SELECT count(*) INTO n FROM public.member_email_links
  WHERE project_id = '20000000-0000-0000-0000-000000000001'
    AND linked_user_id = '10000000-0000-0000-0000-000000000005'
    AND member_user_id = '10000000-0000-0000-0000-000000000004';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALHOU RPC: esperava reutilizar 1 alias, encontrou %', n;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.reviews
    WHERE id = '44000000-0000-0000-0000-000000000003'
      AND reviewer_id = '10000000-0000-0000-0000-000000000004'
      AND resolved_by = '10000000-0000-0000-0000-000000000005'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.project_comments
    WHERE id = '47000000-0000-0000-0000-000000000003'
      AND author_id = '10000000-0000-0000-0000-000000000005'
      AND resolved_by = '10000000-0000-0000-0000-000000000005'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.difficulty_resolutions
    WHERE id = '49000000-0000-0000-0000-000000000001'
      AND resolved_by = '10000000-0000-0000-0000-000000000005'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.error_resolutions
    WHERE id = '49000000-0000-0000-0000-000000000002'
      AND resolved_by = '10000000-0000-0000-0000-000000000005'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.note_resolutions
    WHERE id = '49000000-0000-0000-0000-000000000003'
      AND resolved_by = '10000000-0000-0000-0000-000000000005'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.assignment_batches
    WHERE id = '4a000000-0000-0000-0000-000000000001'
      AND created_by = '10000000-0000-0000-0000-000000000005'
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
  ('30000000-0000-0000-0000-000000000006', '20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000004', 'direct-member@example.test', NULL, '10000000-0000-0000-0000-000000000001');

DO $$
BEGIN
  BEGIN
    PERFORM public.unify_project_members(
      '20000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-00000000000b',
      '10000000-0000-0000-0000-000000000004',
      '10000000-0000-0000-0000-000000000001'
    );
    RAISE EXCEPTION 'TESTE FALHOU: colisão de e-mail foi ignorada';
  EXCEPTION
    WHEN unique_violation THEN
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

  SELECT count(*) INTO n
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename = 'member_email_links'
    AND indexname = 'member_email_links_linked_user_project_key'
    AND indexdef LIKE '%UNIQUE INDEX%linked_user_id, project_id%WHERE (linked_user_id IS NOT NULL)%';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALHOU contrato: índice único parcial ausente';
  END IF;

  SELECT count(*) INTO n
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND indexname = 'idx_member_email_links_linked_user';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FALHOU contrato: índice simples redundante permanece';
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
    'public.auth_user_coordinator_project_ids()'::regprocedure
  ) INTO definition;
  IF definition NOT ILIKE '%member_email_links%'
     OR definition NOT ILIKE '%NOT EXISTS%'
  THEN
    RAISE EXCEPTION 'FALHOU contrato: coordenação não usa precedência canônica';
  END IF;

  SELECT pg_get_functiondef(
    'public.auth_user_resolver_project_ids()'::regprocedure
  ) INTO definition;
  IF definition NOT ILIKE '%member_email_links%'
     OR definition NOT ILIKE '%can_resolve%'
  THEN
    RAISE EXCEPTION 'FALHOU contrato: resolver não usa identidade canônica';
  END IF;

  SELECT pg_get_functiondef(
    'public.enforce_terminal_member_email_alias()'::regprocedure
  ) INTO definition;
  IF definition NOT ILIKE '%pg_advisory_xact_lock%'
     OR definition NOT ILIKE '%linked_user_id = new.member_user_id%'
     OR definition NOT ILIKE '%member_user_id = new.linked_user_id%'
  THEN
    RAISE EXCEPTION
      'FALHOU contrato: trigger não serializa ou não exige aliases terminais';
  END IF;

  SELECT pg_get_functiondef(
    'public.enforce_project_members_column_guard()'::regprocedure
  ) INTO definition;
  IF definition NOT ILIKE '%old.user_id = public.clerk_uid()%'
     OR definition NOT ILIKE '%auth_user_member_identity_ids%'
  THEN
    RAISE EXCEPTION
      'FALHOU contrato: guard não protege identidades bruta e canônica';
  END IF;

  SELECT pg_get_functiondef(
    'public.unify_project_members(uuid,uuid,uuid,uuid)'::regprocedure
  ) INTO definition;
  IF definition NOT ILIKE '%pg_advisory_xact_lock%'
     OR definition NOT ILIKE '%order by pm.user_id%'
     OR definition NOT ILIKE '%for update%'
     OR definition NOT ILIKE '%v_locked_membership_count <> 2%'
  THEN
    RAISE EXCEPTION
      'FALHOU contrato: unificação não bloqueia e revalida as memberships';
  END IF;

  RAISE NOTICE 'OK: constraints, índices, functions e policy final conferidos';
END;
$$;

ROLLBACK;
