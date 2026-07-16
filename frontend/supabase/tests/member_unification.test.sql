-- Contrato integrado da unificação canônica de membros.
--
-- Como rodar após `npx supabase db reset`:
--   docker exec -i supabase_db_frontend psql -U postgres -d postgres \
--     -X -v ON_ERROR_STOP=1 < supabase/tests/member_unification.test.sql

BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('a1000000-0000-0000-0000-000000000001', 'unify-coord@example.test'),
  ('a1000000-0000-0000-0000-000000000002', 'unify-source@example.test'),
  ('a1000000-0000-0000-0000-000000000003', 'unify-target@example.test');

INSERT INTO public.projects (
  id, name, created_by, pydantic_hash, pydantic_fields,
  schema_version_major, schema_version_minor, schema_version_patch
) VALUES (
  'a2000000-0000-0000-0000-000000000001', 'Unificação integrada',
  'a1000000-0000-0000-0000-000000000001', 'schema-v1',
  '[{"name":"campo","hash":"hash-v1"}]', 1, 0, 0
);

INSERT INTO public.project_members (
  project_id, user_id, role, can_arbitrate, can_compare
) VALUES
  ('a2000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'coordenador', true, true),
  ('a2000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000002', 'pesquisador', true, true),
  ('a2000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000003', 'pesquisador', false, false);

INSERT INTO public.documents (
  id, project_id, title, text, excluded_at, excluded_by, excluded_reason
) VALUES
  ('a3000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', 'Respostas duplicadas', 'd1', NULL, NULL, NULL),
  ('a3000000-0000-0000-0000-000000000002', 'a2000000-0000-0000-0000-000000000001', 'Arbitragem aberta', 'd2', NULL, NULL, NULL),
  ('a3000000-0000-0000-0000-000000000003', 'a2000000-0000-0000-0000-000000000001', 'Exclusão histórica', 'd3', '2026-07-01 12:00:00+00', 'a1000000-0000-0000-0000-000000000002', 'fora do escopo');

INSERT INTO public.responses (
  id, project_id, document_id, respondent_id, respondent_type,
  respondent_name, answers, justifications, is_latest, pydantic_hash,
  schema_version_major, schema_version_minor, schema_version_patch,
  version_inferred_from, answer_field_hashes, created_at
) VALUES
  ('a4000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000002', 'humano', 'Source', '{"campo":"source"}', '{}', true, 'schema-v1', 1, 0, 0, 'live_save', '{"campo":"hash-v1"}', '2026-07-01 10:00:00+00'),
  ('a4000000-0000-0000-0000-000000000002', 'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000003', 'humano', 'Target', '{"campo":"target"}', '{}', true, 'schema-v1', 1, 0, 0, 'live_save', '{"campo":"hash-v1"}', '2026-07-01 11:00:00+00'),
  ('a4000000-0000-0000-0000-000000000003', 'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', NULL, 'llm', 'LLM', '{"campo":"llm"}', '{}', true, 'schema-v1', 1, 0, 0, NULL, '{"campo":"hash-v1"}', '2026-07-01 09:00:00+00'),
  ('a4000000-0000-0000-0000-000000000004', 'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000003', 'humano', 'Target', '{"campo":"humano"}', '{}', true, 'schema-v1', 1, 0, 0, 'live_save', '{"campo":"hash-v1"}', '2026-07-01 09:00:00+00'),
  ('a4000000-0000-0000-0000-000000000005', 'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000002', NULL, 'llm', 'LLM', '{"campo":"llm"}', '{}', true, 'schema-v1', 1, 0, 0, NULL, '{"campo":"hash-v1"}', '2026-07-01 09:00:00+00');

INSERT INTO public.field_reviews (
  id, project_id, document_id, field_name, human_response_id, llm_response_id,
  self_reviewer_id, self_verdict, self_reviewed_at, self_justification,
  arbitrator_id, blind_verdict, blind_decided_at
) VALUES
  ('a5000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', 'campo', 'a4000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000003', 'a1000000-0000-0000-0000-000000000002', NULL, NULL, NULL, NULL, NULL, NULL),
  ('a5000000-0000-0000-0000-000000000002', 'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000002', 'campo', 'a4000000-0000-0000-0000-000000000004', 'a4000000-0000-0000-0000-000000000005', 'a1000000-0000-0000-0000-000000000003', 'contesta_llm', now(), 'justificativa', 'a1000000-0000-0000-0000-000000000002', 'humano', now());

INSERT INTO public.assignments (
  id, project_id, document_id, user_id, status, completed_at, type
) VALUES
  ('a6000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000002', 'pendente', NULL, 'auto_revisao'),
  ('a6000000-0000-0000-0000-000000000002', 'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000003', 'concluido', now(), 'auto_revisao'),
  ('a6000000-0000-0000-0000-000000000003', 'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000002', 'em_andamento', NULL, 'arbitragem');

INSERT INTO public.project_comments (
  id, project_id, document_id, author_id, body, kind,
  resolved_at, resolved_by
) VALUES (
  'a7000000-0000-0000-0000-000000000001',
  'a2000000-0000-0000-0000-000000000001',
  'a3000000-0000-0000-0000-000000000003',
  'a1000000-0000-0000-0000-000000000002', 'fora do escopo',
  'exclusion_request', '2026-07-01 12:00:00+00',
  'a1000000-0000-0000-0000-000000000002'
);

-- A autorização é validada antes de qualquer migração de identidade. Passar
-- um pesquisador como ator explícito deve falhar sem remover a membership.
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL ROLE service_role;
DO $$
BEGIN
  BEGIN
    PERFORM public.unify_project_members(
      'a2000000-0000-0000-0000-000000000001',
      'a1000000-0000-0000-0000-000000000002',
      'a1000000-0000-0000-0000-000000000003',
      'a1000000-0000-0000-0000-000000000002'
    );
    RAISE EXCEPTION 'ator sem autoridade conseguiu unificar membros';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    NULL;
  END;
END;
$$;
RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.project_members
    WHERE project_id = 'a2000000-0000-0000-0000-000000000001'
      AND user_id = 'a1000000-0000-0000-0000-000000000002'
  ) OR EXISTS (
    SELECT 1 FROM public.member_email_links
    WHERE project_id = 'a2000000-0000-0000-0000-000000000001'
      AND linked_user_id = 'a1000000-0000-0000-0000-000000000002'
  ) THEN
    RAISE EXCEPTION 'rejeição por autoridade deixou efeito parcial';
  END IF;
END;
$$;

-- Uma decisão final não pode colapsar a autoria do auto-revisor e do árbitro.
-- A fixture é removida depois da prova para liberar o caminho feliz abaixo.
INSERT INTO public.documents (id, project_id, title, text) VALUES (
  'a3000000-0000-0000-0000-000000000004',
  'a2000000-0000-0000-0000-000000000001',
  'Decisão final incompatível', 'd4'
);
INSERT INTO public.responses (
  id, project_id, document_id, respondent_id, respondent_type,
  respondent_name, answers, justifications, is_latest, pydantic_hash,
  schema_version_major, schema_version_minor, schema_version_patch,
  version_inferred_from, answer_field_hashes
) VALUES
  ('a4000000-0000-0000-0000-000000000006', 'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000004', 'a1000000-0000-0000-0000-000000000002', 'humano', 'Source', '{"campo":"humano"}', '{}', true, 'schema-v1', 1, 0, 0, 'live_save', '{"campo":"hash-v1"}'),
  ('a4000000-0000-0000-0000-000000000007', 'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000004', NULL, 'llm', 'LLM', '{"campo":"llm"}', '{}', true, 'schema-v1', 1, 0, 0, NULL, '{"campo":"hash-v1"}');
INSERT INTO public.field_reviews (
  id, project_id, document_id, field_name, human_response_id, llm_response_id,
  self_reviewer_id, self_verdict, self_reviewed_at, self_justification,
  arbitrator_id, blind_verdict, blind_decided_at,
  final_verdict, final_decided_at
) VALUES (
  'a5000000-0000-0000-0000-000000000003',
  'a2000000-0000-0000-0000-000000000001',
  'a3000000-0000-0000-0000-000000000004', 'campo',
  'a4000000-0000-0000-0000-000000000006',
  'a4000000-0000-0000-0000-000000000007',
  'a1000000-0000-0000-0000-000000000002',
  'contesta_llm', now(), 'justificativa',
  'a1000000-0000-0000-0000-000000000003',
  'humano', now(), 'humano', now()
);

SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL ROLE service_role;
DO $$
BEGIN
  BEGIN
    PERFORM public.unify_project_members(
      'a2000000-0000-0000-0000-000000000001',
      'a1000000-0000-0000-0000-000000000002',
      'a1000000-0000-0000-0000-000000000003',
      'a1000000-0000-0000-0000-000000000001'
    );
    RAISE EXCEPTION 'decisão final permitiu colapsar revisor e árbitro';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    NULL;
  END;
END;
$$;
RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.project_members
    WHERE project_id = 'a2000000-0000-0000-0000-000000000001'
      AND user_id = 'a1000000-0000-0000-0000-000000000002'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.field_reviews
    WHERE id = 'a5000000-0000-0000-0000-000000000003'
      AND self_reviewer_id = 'a1000000-0000-0000-0000-000000000002'
      AND arbitrator_id = 'a1000000-0000-0000-0000-000000000003'
      AND final_verdict = 'humano'
  ) OR EXISTS (
    SELECT 1 FROM public.member_email_links
    WHERE project_id = 'a2000000-0000-0000-0000-000000000001'
      AND linked_user_id = 'a1000000-0000-0000-0000-000000000002'
  ) THEN
    RAISE EXCEPTION 'rejeição da colisão final deixou efeito parcial';
  END IF;
END;
$$;

DELETE FROM public.field_reviews
WHERE id = 'a5000000-0000-0000-0000-000000000003';
DELETE FROM public.responses
WHERE id IN (
  'a4000000-0000-0000-0000-000000000006',
  'a4000000-0000-0000-0000-000000000007'
);
DELETE FROM public.documents
WHERE id = 'a3000000-0000-0000-0000-000000000004';

-- Um vínculo pendente incompatível para o e-mail principal do source não pode
-- ser engolido: a unificação inteira falha e preserva a membership.
INSERT INTO public.member_email_links (
  project_id, member_user_id, email, linked_user_id, created_by
) VALUES (
  'a2000000-0000-0000-0000-000000000001',
  'a1000000-0000-0000-0000-000000000001',
  'unify-source@example.test', NULL,
  'a1000000-0000-0000-0000-000000000001'
);
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL ROLE service_role;
DO $$
BEGIN
  BEGIN
    PERFORM public.unify_project_members(
      'a2000000-0000-0000-0000-000000000001',
      'a1000000-0000-0000-0000-000000000002',
      'a1000000-0000-0000-0000-000000000003',
      'a1000000-0000-0000-0000-000000000001'
    );
    RAISE EXCEPTION 'conflito de e-mail foi ignorado pela unificação';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    NULL;
  END;
END;
$$;
RESET ROLE;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.project_members
    WHERE project_id = 'a2000000-0000-0000-0000-000000000001'
      AND user_id = 'a1000000-0000-0000-0000-000000000002'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.member_email_links
    WHERE project_id = 'a2000000-0000-0000-0000-000000000001'
      AND email = 'unify-source@example.test'
      AND member_user_id = 'a1000000-0000-0000-0000-000000000001'
      AND linked_user_id IS NULL
  ) THEN
    RAISE EXCEPTION 'conflito de e-mail deixou efeito parcial';
  END IF;
END;
$$;
DELETE FROM public.member_email_links
WHERE project_id = 'a2000000-0000-0000-0000-000000000001'
  AND email = 'unify-source@example.test';

-- Torna as respostas anteriores stale; a unificação não pode exigir o schema
-- corrente para apenas reconciliar identidade/is_latest.
UPDATE public.projects
SET pydantic_hash = 'schema-v2',
    pydantic_fields = '[{"name":"campo","hash":"hash-v2"}]',
    schema_version_minor = 1,
    out_of_scope_enabled = true
WHERE id = 'a2000000-0000-0000-0000-000000000001';

SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL ROLE service_role;
SELECT public.unify_project_members(
  'a2000000-0000-0000-0000-000000000001',
  'a1000000-0000-0000-0000-000000000002',
  'a1000000-0000-0000-0000-000000000003',
  'a1000000-0000-0000-0000-000000000001'
);
RESET ROLE;

-- O schema impede que o mesmo login alias aponte para dois membros no mesmo
-- projeto; consumidores não precisam reconstruir/detectar ambiguidade.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.member_email_links (
      project_id, member_user_id, email, linked_user_id, created_by
    ) VALUES (
      'a2000000-0000-0000-0000-000000000001',
      'a1000000-0000-0000-0000-000000000001',
      'destino-divergente@example.test',
      'a1000000-0000-0000-0000-000000000002',
      'a1000000-0000-0000-0000-000000000001'
    );
    RAISE EXCEPTION 'schema aceitou dois destinos para o mesmo login alias';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.field_reviews
    WHERE id = 'a5000000-0000-0000-0000-000000000001'
      AND self_reviewer_id = 'a1000000-0000-0000-0000-000000000003'
      AND self_verdict IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM public.assignments
    WHERE id = 'a6000000-0000-0000-0000-000000000002'
      AND status = 'pendente' AND completed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'trabalho de auto-revisão migrado ficou escondido como concluído';
  END IF;
END;
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO public.member_email_links (
      project_id, member_user_id, email, linked_user_id, created_by
    ) VALUES (
      'a2000000-0000-0000-0000-000000000001',
      'a1000000-0000-0000-0000-000000000003',
      'self-alias@example.test',
      'a1000000-0000-0000-0000-000000000003',
      'a1000000-0000-0000-0000-000000000001'
    );
    RAISE EXCEPTION 'schema aceitou self-link';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    NULL;
  END;

  BEGIN
    INSERT INTO public.project_members (project_id, user_id, role) VALUES (
      'a2000000-0000-0000-0000-000000000001',
      'a1000000-0000-0000-0000-000000000002',
      'pesquisador'
    );
    RAISE EXCEPTION 'schema aceitou alias como membership';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    NULL;
  END;

  BEGIN
    INSERT INTO public.member_email_links (
      project_id, member_user_id, email, linked_user_id, created_by
    ) VALUES (
      'a2000000-0000-0000-0000-000000000001',
      'a1000000-0000-0000-0000-000000000003',
      'member-as-alias@example.test',
      'a1000000-0000-0000-0000-000000000001',
      'a1000000-0000-0000-0000-000000000001'
    );
    RAISE EXCEPTION 'schema aceitou membership existente como alias';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    NULL;
  END;

  BEGIN
    INSERT INTO public.member_email_links (
      project_id, member_user_id, email, linked_user_id, created_by
    ) VALUES (
      'a2000000-0000-0000-0000-000000000001',
      'a1000000-0000-0000-0000-000000000002',
      'missing-target@example.test',
      'a1000000-0000-0000-0000-000000000001',
      'a1000000-0000-0000-0000-000000000001'
    );
    RAISE EXCEPTION 'schema aceitou target sem membership';
  EXCEPTION WHEN SQLSTATE '23503' THEN
    NULL;
  END;
END;
$$;

-- Prepara uma arbitragem final independente. O login source chamará a RPC
-- como alias, mas a autoria do comentário deve ser o target canônico.
UPDATE public.project_members
SET can_arbitrate = true
WHERE project_id = 'a2000000-0000-0000-0000-000000000001'
  AND user_id = 'a1000000-0000-0000-0000-000000000003';
INSERT INTO public.documents (id, project_id, title, text) VALUES (
  'a3000000-0000-0000-0000-000000000004',
  'a2000000-0000-0000-0000-000000000001',
  'Arbitragem pós-alias', 'd4'
);
INSERT INTO public.responses (
  id, project_id, document_id, respondent_id, respondent_type,
  respondent_name, answers, justifications, is_latest, pydantic_hash,
  schema_version_major, schema_version_minor, schema_version_patch,
  version_inferred_from, answer_field_hashes
) VALUES
  ('a4000000-0000-0000-0000-000000000006', 'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000004', 'a1000000-0000-0000-0000-000000000001', 'humano', 'Coord', '{"campo":"humano"}', '{}', true, 'schema-v2', 1, 1, 0, 'live_save', '{"campo":"hash-v2"}'),
  ('a4000000-0000-0000-0000-000000000007', 'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000004', NULL, 'llm', 'LLM', '{"campo":"llm"}', '{}', true, 'schema-v2', 1, 1, 0, NULL, '{"campo":"hash-v2"}');
INSERT INTO public.field_reviews (
  id, project_id, document_id, field_name, human_response_id, llm_response_id,
  self_reviewer_id, self_verdict, self_reviewed_at, self_justification,
  arbitrator_id, blind_verdict, blind_decided_at
) VALUES (
  'a5000000-0000-0000-0000-000000000003',
  'a2000000-0000-0000-0000-000000000001',
  'a3000000-0000-0000-0000-000000000004', 'campo',
  'a4000000-0000-0000-0000-000000000006',
  'a4000000-0000-0000-0000-000000000007',
  'a1000000-0000-0000-0000-000000000001',
  'contesta_llm', now(), 'coord contesta',
  'a1000000-0000-0000-0000-000000000003', 'humano', now()
);

-- O login source agora é apenas um alias. Policies, guards e RPCs devem
-- materializar todo trabalho novo sob o target canônico.
SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"a1000000-0000-0000-0000-000000000002"}', true
);
SET LOCAL ROLE authenticated;
SELECT public.submit_compare_review(
  'a2000000-0000-0000-0000-000000000001',
  'a3000000-0000-0000-0000-000000000001', 'campo',
  'ambiguo', NULL,
  'comparação criada pelo alias',
  ARRAY[
    'a4000000-0000-0000-0000-000000000002'::uuid,
    'a4000000-0000-0000-0000-000000000003'::uuid
  ],
  NULL,
  false
);
SELECT public.submit_self_review(
  'a2000000-0000-0000-0000-000000000001',
  'a3000000-0000-0000-0000-000000000001',
  '[{
    "fieldReviewId":"a5000000-0000-0000-0000-000000000001",
    "verdict":"ambiguo",
    "justification":"auto-revisão criada pelo alias"
  }]'
);
SELECT public.submit_final_arbitration(
  'a2000000-0000-0000-0000-000000000001',
  'a3000000-0000-0000-0000-000000000004',
  '[{
    "fieldReviewId":"a5000000-0000-0000-0000-000000000003",
    "verdict":"llm",
    "questionImprovementSuggestion":"melhorar após alias",
    "arbitratorComment":"arbitragem criada pelo alias"
  }]'
);
SELECT public.request_document_exclusion(
  'a2000000-0000-0000-0000-000000000001',
  'a3000000-0000-0000-0000-000000000001',
  'pedido criado pelo alias'
);
RESET ROLE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.project_members
    WHERE project_id = 'a2000000-0000-0000-0000-000000000001'
      AND user_id = 'a1000000-0000-0000-0000-000000000002'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.member_email_links
    WHERE project_id = 'a2000000-0000-0000-0000-000000000001'
      AND member_user_id = 'a1000000-0000-0000-0000-000000000003'
      AND linked_user_id = 'a1000000-0000-0000-0000-000000000002'
  ) THEN
    RAISE EXCEPTION 'unificação não removeu membership e criou alias canônico';
  END IF;
  IF (
    SELECT count(*) FROM public.responses
    WHERE project_id = 'a2000000-0000-0000-0000-000000000001'
      AND document_id = 'a3000000-0000-0000-0000-000000000001'
      AND respondent_id = 'a1000000-0000-0000-0000-000000000003'
      AND respondent_type = 'humano'
  ) <> 2 OR (
    SELECT count(*) FROM public.responses
    WHERE project_id = 'a2000000-0000-0000-0000-000000000001'
      AND document_id = 'a3000000-0000-0000-0000-000000000001'
      AND respondent_id = 'a1000000-0000-0000-0000-000000000003'
      AND respondent_type = 'humano'
      AND is_latest
  ) <> 1 THEN
    RAISE EXCEPTION 'respostas stale não foram reconciliadas para uma latest';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.field_reviews
    WHERE id = 'a5000000-0000-0000-0000-000000000002'
      AND arbitrator_id IS NULL
      AND blind_verdict IS NULL
      AND blind_decided_at IS NULL
  ) OR EXISTS (
    SELECT 1 FROM public.assignments
    WHERE id = 'a6000000-0000-0000-0000-000000000003'
  ) THEN
    RAISE EXCEPTION 'arbitragem inelegível não voltou para a fila';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.project_comments
    WHERE id = 'a7000000-0000-0000-0000-000000000001'
      AND author_id = 'a1000000-0000-0000-0000-000000000003'
      AND resolved_by = 'a1000000-0000-0000-0000-000000000003'
  ) THEN
    RAISE EXCEPTION 'histórico de exclusion_request não foi reconciliado';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.documents
    WHERE id = 'a3000000-0000-0000-0000-000000000003'
      AND excluded_by = 'a1000000-0000-0000-0000-000000000003'
  ) THEN
    RAISE EXCEPTION 'autoria histórica da exclusão não foi reconciliada';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM public.project_comments
       WHERE project_id = 'a2000000-0000-0000-0000-000000000001'
         AND document_id = 'a3000000-0000-0000-0000-000000000001'
         AND field_name = 'campo'
         AND kind = 'ambiguity'
         AND author_id = 'a1000000-0000-0000-0000-000000000003'
         AND body LIKE '%comparação criada pelo alias%'
     ) OR NOT EXISTS (
       SELECT 1 FROM public.project_comments
       WHERE project_id = 'a2000000-0000-0000-0000-000000000001'
         AND document_id = 'a3000000-0000-0000-0000-000000000001'
         AND field_name = 'campo'
         AND kind = 'note'
         AND author_id = 'a1000000-0000-0000-0000-000000000003'
         AND body LIKE '%auto-revisão criada pelo alias%'
     ) OR NOT EXISTS (
       SELECT 1 FROM public.project_comments
       WHERE project_id = 'a2000000-0000-0000-0000-000000000001'
         AND document_id = 'a3000000-0000-0000-0000-000000000004'
         AND field_name = 'campo'
         AND kind = 'note'
         AND author_id = 'a1000000-0000-0000-0000-000000000003'
         AND body LIKE '%arbitragem criada pelo alias%'
     ) OR NOT EXISTS (
       SELECT 1 FROM public.project_comments
       WHERE project_id = 'a2000000-0000-0000-0000-000000000001'
         AND document_id = 'a3000000-0000-0000-0000-000000000001'
         AND kind = 'exclusion_request'
         AND author_id = 'a1000000-0000-0000-0000-000000000003'
         AND body = 'pedido criado pelo alias'
     ) THEN
    RAISE EXCEPTION 'alias não persistiu trabalho novo sob identidade canônica';
  END IF;
  RAISE NOTICE 'OK unificação: stale, comentários, field_reviews e filas';
END;
$$;

ROLLBACK;
