BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('a9a00000-0000-0000-0000-000000000001', 'decision-owner@example.test'),
  ('a9a00000-0000-0000-0000-000000000002', 'decision-resolver@example.test'),
  ('a9a00000-0000-0000-0000-000000000003', 'decision-reader@example.test'),
  ('a9a00000-0000-0000-0000-000000000004', 'decision-outsider@example.test'),
  ('a9a00000-0000-0000-0000-000000000005', 'decision-alias@example.test');
INSERT INTO public.clerk_user_mapping (clerk_user_id, supabase_user_id, access_sync_version)
  SELECT id::TEXT, id, 1 FROM auth.users WHERE id::TEXT LIKE 'a9a00000-%';
INSERT INTO public.projects (id, name, created_by, automation_mode, pydantic_fields) VALUES
  ('a9b00000-0000-0000-0000-000000000001', 'Decision test', 'a9a00000-0000-0000-0000-000000000001', 'compare_llm',
   '[{"name":"q","type":"text","description":"Pergunta"},{"name":"other","type":"text","description":"Outra"}]');
INSERT INTO public.project_members (project_id, user_id, role, can_resolve) VALUES
  ('a9b00000-0000-0000-0000-000000000001', 'a9a00000-0000-0000-0000-000000000002', 'pesquisador', true),
  ('a9b00000-0000-0000-0000-000000000001', 'a9a00000-0000-0000-0000-000000000003', 'pesquisador', false);
INSERT INTO public.member_email_links (project_id, member_user_id, linked_user_id, email, created_by) VALUES
  ('a9b00000-0000-0000-0000-000000000001', 'a9a00000-0000-0000-0000-000000000002',
   'a9a00000-0000-0000-0000-000000000005', 'decision-alias@example.test', 'a9a00000-0000-0000-0000-000000000001');
INSERT INTO public.documents (id, project_id, title, text) VALUES
  ('a9c00000-0000-0000-0000-000000000001', 'a9b00000-0000-0000-0000-000000000001', 'Documento', 'Texto');
INSERT INTO public.responses (id, project_id, document_id, respondent_id, respondent_type, answers) VALUES
  ('a9d00000-0000-0000-0000-000000000001', 'a9b00000-0000-0000-0000-000000000001', 'a9c00000-0000-0000-0000-000000000001', NULL, 'llm', '{"q":"LLM","other":"igual"}'),
  ('a9d00000-0000-0000-0000-000000000002', 'a9b00000-0000-0000-0000-000000000001', 'a9c00000-0000-0000-0000-000000000001', 'a9a00000-0000-0000-0000-000000000002', 'humano', '{"q":"Humano","other":"igual"}');
INSERT INTO public.reviews (id, project_id, document_id, field_name, reviewer_id, verdict, chosen_response_id) VALUES
  ('a9e00000-0000-0000-0000-000000000001', 'a9b00000-0000-0000-0000-000000000001', 'a9c00000-0000-0000-0000-000000000001', 'q', 'a9a00000-0000-0000-0000-000000000002', 'Humano', 'a9d00000-0000-0000-0000-000000000002');
INSERT INTO public.error_resolutions (project_id, document_id, field_name, resolved_by, note) VALUES
  ('a9b00000-0000-0000-0000-000000000001', 'a9c00000-0000-0000-0000-000000000001', 'other', 'a9a00000-0000-0000-0000-000000000001', 'Legado');

SELECT set_config('request.jwt.claims', '{"sub":"a9a00000-0000-0000-0000-000000000001","supabase_uid":"a9a00000-0000-0000-0000-000000000001"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  c JSONB;
  saved JSONB;
  item RECORD;
  choice TEXT;
BEGIN
  c := public.llm_error_context('a9b00000-0000-0000-0000-000000000001', 'a9c00000-0000-0000-0000-000000000001', 'q',
    'a9d00000-0000-0000-0000-000000000001', 'a9d00000-0000-0000-0000-000000000002', 'comparacao', 'a9e00000-0000-0000-0000-000000000001');
  IF c IS NULL THEN RAISE EXCEPTION 'FALHOU: contexto ausente para creator sem membership'; END IF;
  IF COALESCE(c->'source'->>'responses_hash','') !~ '^[a-f0-9]{64}$'
    OR c->'source' ? 'llm_answers' OR c->'source' ? 'human_answers' THEN
    RAISE EXCEPTION 'FALHOU: contexto deve resumir as respostas por hash';
  END IF;
  FOREACH choice IN ARRAY ARRAY['llm_correct', 'researchers_correct', 'discussion'] LOOP
    saved := public.set_error_resolution('a9b00000-0000-0000-0000-000000000001', 'a9c00000-0000-0000-0000-000000000001', 'q',
      choice, c, NULL, NULL, 'Conferido');
    SELECT * INTO item FROM public.read_error_resolutions('a9b00000-0000-0000-0000-000000000001') WHERE field_name = 'q';
    IF item.decision IS DISTINCT FROM choice OR item.current_context IS DISTINCT FROM c THEN
      RAISE EXCEPTION 'FALHOU: creator não lê a decisão/contexto persistido';
    END IF;
    BEGIN
      PERFORM public.set_error_resolution('a9b00000-0000-0000-0000-000000000001', 'a9c00000-0000-0000-0000-000000000001', 'q', choice, c, NULL, NULL);
      RAISE EXCEPTION 'FALHOU: segunda confirmação com expectativa antiga foi aceita';
    EXCEPTION WHEN serialization_failure THEN NULL;
    END;
    BEGIN
      PERFORM public.set_error_resolution('a9b00000-0000-0000-0000-000000000001', 'a9c00000-0000-0000-0000-000000000001', 'q', choice,
        jsonb_set(c, '{llm_value,value}', '"adulterado"'), item.id, item.resolved_at);
      RAISE EXCEPTION 'FALHOU: valor forjado foi aceito';
    EXCEPTION WHEN serialization_failure THEN NULL;
    END;
    PERFORM public.set_error_resolution('a9b00000-0000-0000-0000-000000000001', 'a9c00000-0000-0000-0000-000000000001', 'q', NULL, NULL, item.id, item.resolved_at);
    IF EXISTS (SELECT 1 FROM public.error_resolutions WHERE field_name = 'q') THEN RAISE EXCEPTION 'FALHOU: reabertura não removeu resolução'; END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM public.error_resolutions WHERE field_name = 'other' AND decision IS NULL AND context IS NULL AND note = 'Legado') THEN
    RAISE EXCEPTION 'FALHOU: resolução de outro campo ou legado foi alterada';
  END IF;
  BEGIN
    INSERT INTO public.error_resolutions (project_id, document_id, field_name, resolved_by) VALUES
      ('a9b00000-0000-0000-0000-000000000001', 'a9c00000-0000-0000-0000-000000000001', 'q', 'a9a00000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'FALHOU: escrita direta contorna a RPC';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;

SELECT set_config('request.jwt.claims', '{"sub":"a9a00000-0000-0000-0000-000000000005","supabase_uid":"a9a00000-0000-0000-0000-000000000005"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE c JSONB; saved JSONB;
BEGIN
  c := public.llm_error_context('a9b00000-0000-0000-0000-000000000001', 'a9c00000-0000-0000-0000-000000000001', 'q',
    'a9d00000-0000-0000-0000-000000000001', 'a9d00000-0000-0000-0000-000000000002', 'comparacao', 'a9e00000-0000-0000-0000-000000000001');
  saved := public.set_error_resolution('a9b00000-0000-0000-0000-000000000001', 'a9c00000-0000-0000-0000-000000000001', 'q', 'llm_correct', c, NULL, NULL);
  IF saved->>'resolved_by' <> 'a9a00000-0000-0000-0000-000000000005' THEN RAISE EXCEPTION 'FALHOU: autoria não é a conta autenticada'; END IF;
END $$;
RESET ROLE;

SELECT set_config('request.jwt.claims', '{"sub":"a9a00000-0000-0000-0000-000000000003","supabase_uid":"a9a00000-0000-0000-0000-000000000003"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE item RECORD;
BEGIN
  SELECT * INTO item FROM public.read_error_resolutions('a9b00000-0000-0000-0000-000000000001') WHERE field_name = 'q';
  IF item.current_context IS DISTINCT FROM item.context THEN RAISE EXCEPTION 'FALHOU: leitor vê decisão diferente do resolver'; END IF;
  BEGIN
    PERFORM public.set_error_resolution(item.project_id, item.document_id, item.field_name, 'discussion', item.context, item.id, item.resolved_at);
    RAISE EXCEPTION 'FALHOU: leitor sem permissão decidiu';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;

UPDATE public.responses SET answers = '{"q":"alterado","other":"igual"}' WHERE id = 'a9d00000-0000-0000-0000-000000000001';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.read_error_resolutions('a9b00000-0000-0000-0000-000000000001') WHERE field_name = 'q' AND current_context = context) THEN
    RAISE EXCEPTION 'FALHOU: edição na mesma response não invalidou contexto';
  END IF;
END $$;
UPDATE public.responses SET answers = '{"q":"LLM","other":"igual"}' WHERE id = 'a9d00000-0000-0000-0000-000000000001';
INSERT INTO public.reviews (project_id, document_id, field_name, reviewer_id, verdict, chosen_response_id) VALUES
  ('a9b00000-0000-0000-0000-000000000001', 'a9c00000-0000-0000-0000-000000000001', 'q', 'a9a00000-0000-0000-0000-000000000001', 'LLM', 'a9d00000-0000-0000-0000-000000000001');
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.read_error_resolutions('a9b00000-0000-0000-0000-000000000001') WHERE field_name = 'q' AND current_context = context) THEN
    RAISE EXCEPTION 'FALHOU: novo review não invalidou contexto';
  END IF;
END $$;

UPDATE public.projects SET automation_mode = 'auto_review_llm' WHERE id = 'a9b00000-0000-0000-0000-000000000001';
INSERT INTO public.field_reviews (id, project_id, document_id, field_name, human_response_id, llm_response_id,
  human_answer_snapshot, llm_answer_snapshot, self_reviewer_id, self_verdict, self_reviewed_at, self_justification,
  arbitrator_id, blind_verdict, blind_decided_at, final_verdict, final_decided_at) VALUES
  ('a9f00000-0000-0000-0000-000000000001', 'a9b00000-0000-0000-0000-000000000001', 'a9c00000-0000-0000-0000-000000000001', 'q',
   'a9d00000-0000-0000-0000-000000000002', 'a9d00000-0000-0000-0000-000000000001', '"Humano"', '"LLM"',
   'a9a00000-0000-0000-0000-000000000002', 'contesta_llm', now(), 'Revisado',
   'a9a00000-0000-0000-0000-000000000001', 'humano', now(), 'humano', now());
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.auto_review_reconciliation_requests WHERE document_id = 'a9c00000-0000-0000-0000-000000000001') THEN
    RAISE EXCEPTION 'FALHOU: fixture deveria ter reconciliação pendente';
  END IF;
  IF public.llm_error_context('a9b00000-0000-0000-0000-000000000001', 'a9c00000-0000-0000-0000-000000000001', 'q',
    'a9d00000-0000-0000-0000-000000000001', 'a9d00000-0000-0000-0000-000000000002', 'auto_revisao', 'a9f00000-0000-0000-0000-000000000001') IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU: contexto de arbitragem foi aceito durante reconciliação';
  END IF;
END $$;
-- A partir daqui a fixture representa uma reconciliação concluída.
DELETE FROM public.auto_review_reconciliation_requests WHERE document_id = 'a9c00000-0000-0000-0000-000000000001';
SELECT set_config('request.jwt.claims', '{"sub":"a9a00000-0000-0000-0000-000000000005","supabase_uid":"a9a00000-0000-0000-0000-000000000005"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE c JSONB; item RECORD;
BEGIN
  c := public.llm_error_context('a9b00000-0000-0000-0000-000000000001', 'a9c00000-0000-0000-0000-000000000001', 'q',
    'a9d00000-0000-0000-0000-000000000001', 'a9d00000-0000-0000-0000-000000000002', 'auto_revisao', 'a9f00000-0000-0000-0000-000000000001');
  IF c IS NULL THEN RAISE EXCEPTION 'FALHOU: resolver sem papel de árbitro não prepara decisão concluída'; END IF;
  SELECT * INTO item FROM public.read_error_resolutions('a9b00000-0000-0000-0000-000000000001') WHERE field_name = 'q';
  PERFORM public.set_error_resolution(item.project_id, item.document_id, item.field_name, 'researchers_correct', c, item.id, item.resolved_at);
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"sub":"a9a00000-0000-0000-0000-000000000003","supabase_uid":"a9a00000-0000-0000-0000-000000000003"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE item RECORD;
BEGIN
  BEGIN
    IF EXISTS (SELECT 1 FROM public.field_reviews WHERE id = 'a9f00000-0000-0000-0000-000000000001') THEN
      RAISE EXCEPTION 'FALHOU: fixture deveria estar fora do acesso individual à arbitragem';
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  SELECT * INTO item FROM public.read_error_resolutions('a9b00000-0000-0000-0000-000000000001') WHERE field_name = 'q';
  IF item.current_context IS NULL OR item.context IS DISTINCT FROM item.current_context THEN
    RAISE EXCEPTION 'FALHOU: decisão de auto-revisão depende de quem a lê';
  END IF;
END $$;
RESET ROLE;

SELECT set_config('request.jwt.claims', '{"sub":"a9a00000-0000-0000-0000-000000000004","supabase_uid":"a9a00000-0000-0000-0000-000000000004"}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.read_error_resolutions('a9b00000-0000-0000-0000-000000000001')) THEN RAISE EXCEPTION 'FALHOU: vazamento de resoluções entre projetos'; END IF;
  IF public.llm_error_context('a9b00000-0000-0000-0000-000000000001', 'a9c00000-0000-0000-0000-000000000001', 'q',
    'a9d00000-0000-0000-0000-000000000001', 'a9d00000-0000-0000-0000-000000000002', 'comparacao', 'a9e00000-0000-0000-0000-000000000001') IS NOT NULL
    THEN RAISE EXCEPTION 'FALHOU: vazamento de contexto entre projetos'; END IF;
END $$;
RESET ROLE;

DO $$
BEGIN
  IF (SELECT answers->>'q' FROM public.responses WHERE respondent_type = 'humano' AND document_id = 'a9c00000-0000-0000-0000-000000000001') <> 'Humano'
    THEN RAISE EXCEPTION 'FALHOU: codificação humana alterada'; END IF;
END $$;
ROLLBACK;
