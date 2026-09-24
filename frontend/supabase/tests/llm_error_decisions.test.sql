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
    -- Erro do LLM exige o valor aprovado (#733); `q` e texto livre.
    saved := public.set_error_resolution('a9b00000-0000-0000-0000-000000000001', 'a9c00000-0000-0000-0000-000000000001', 'q',
      choice, c, NULL, NULL, 'Conferido', CASE WHEN choice = 'researchers_correct' THEN '"Humano"'::JSONB END);
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
  PERFORM public.set_error_resolution(item.project_id, item.document_id, item.field_name, 'researchers_correct', c, item.id, item.resolved_at, NULL, '"Humano"'::JSONB);
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
-- ========== "Erro do LLM" leva o veredito nas opcoes atuais (#733) ==========
-- Projeto proprio, para nao depender do estado que o fluxo acima deixou.
-- Cobre: p_value obrigatorio e validado por tipo; approved_value devolvido por
-- read_error_resolutions; contexto sem schema_revision (save de schema em
-- OUTRA pergunta nao invalida, mudanca na PROPRIA invalida); CHECK da coluna.
INSERT INTO public.projects (id, name, created_by, automation_mode, pydantic_fields) VALUES
  ('a9b00000-0000-0000-0000-000000000002', 'Decision value test', 'a9a00000-0000-0000-0000-000000000001', 'compare_llm',
   '[{"name":"s","type":"single","options":["A","B "],"description":"Única"},
     {"name":"m","type":"multi","options":["A","B","C"],"description":"Múltipla"},
     {"name":"g","type":"text","options":null,"description":"Grupo","subfields":[{"key":"anos","label":"Anos"},{"key":"meses","label":"Meses"}]},
     {"name":"t","type":"text","options":null,"description":"Livre"},
     {"name":"o","type":"single","options":["A"],"description":"Única com Outro","allow_other":true},
     {"name":"mo","type":"multi","options":["A","B"],"description":"Múltipla com Outro","allow_other":true},
     {"name":"d","type":"date","options":["Sem data"],"description":"Data"},
     {"name":"n","type":"text","options":null,"description":"Ausente na resposta do LLM"}]');
INSERT INTO public.documents (id, project_id, title, text) VALUES
  ('a9c00000-0000-0000-0000-000000000002', 'a9b00000-0000-0000-0000-000000000002', 'Documento 2', 'Texto');
INSERT INTO public.responses (id, project_id, document_id, respondent_id, respondent_type, answers) VALUES
  ('a9d00000-0000-0000-0000-000000000003', 'a9b00000-0000-0000-0000-000000000002', 'a9c00000-0000-0000-0000-000000000002', NULL, 'llm',
   '{"s":"A","m":["A"],"g":{"anos":"1"},"t":"LLM","o":"A","mo":["A"],"d":"01/02/2026"}'),
  ('a9d00000-0000-0000-0000-000000000004', 'a9b00000-0000-0000-0000-000000000002', 'a9c00000-0000-0000-0000-000000000002', 'a9a00000-0000-0000-0000-000000000002', 'humano',
   '{"s":"A","m":["A","B"],"g":{"anos":"2"},"t":"Humano","o":"Outro: livre","mo":["A","Outro: livre"],"d":"XX/03/2024","n":"Humano"}');
INSERT INTO public.reviews (id, project_id, document_id, field_name, reviewer_id, verdict, chosen_response_id) VALUES
  ('a9e00000-0000-0000-0000-000000000011', 'a9b00000-0000-0000-0000-000000000002', 'a9c00000-0000-0000-0000-000000000002', 's', 'a9a00000-0000-0000-0000-000000000002', 'B ', 'a9d00000-0000-0000-0000-000000000004'),
  ('a9e00000-0000-0000-0000-000000000012', 'a9b00000-0000-0000-0000-000000000002', 'a9c00000-0000-0000-0000-000000000002', 'm', 'a9a00000-0000-0000-0000-000000000002', '{"A":true,"C":true}', 'a9d00000-0000-0000-0000-000000000004'),
  ('a9e00000-0000-0000-0000-000000000013', 'a9b00000-0000-0000-0000-000000000002', 'a9c00000-0000-0000-0000-000000000002', 'g', 'a9a00000-0000-0000-0000-000000000002', 'anos: 2', 'a9d00000-0000-0000-0000-000000000004'),
  ('a9e00000-0000-0000-0000-000000000014', 'a9b00000-0000-0000-0000-000000000002', 'a9c00000-0000-0000-0000-000000000002', 't', 'a9a00000-0000-0000-0000-000000000002', 'Humano', 'a9d00000-0000-0000-0000-000000000004'),
  ('a9e00000-0000-0000-0000-000000000015', 'a9b00000-0000-0000-0000-000000000002', 'a9c00000-0000-0000-0000-000000000002', 'o', 'a9a00000-0000-0000-0000-000000000002', 'Outro: livre', 'a9d00000-0000-0000-0000-000000000004'),
  ('a9e00000-0000-0000-0000-000000000016', 'a9b00000-0000-0000-0000-000000000002', 'a9c00000-0000-0000-0000-000000000002', 'mo', 'a9a00000-0000-0000-0000-000000000002', '{"A":true,"Outro: livre":true}', 'a9d00000-0000-0000-0000-000000000004'),
  ('a9e00000-0000-0000-0000-000000000017', 'a9b00000-0000-0000-0000-000000000002', 'a9c00000-0000-0000-0000-000000000002', 'd', 'a9a00000-0000-0000-0000-000000000002', 'ambiguo', 'a9d00000-0000-0000-0000-000000000004'),
  ('a9e00000-0000-0000-0000-000000000018', 'a9b00000-0000-0000-0000-000000000002', 'a9c00000-0000-0000-0000-000000000002', 'n', 'a9a00000-0000-0000-0000-000000000002', 'Humano', 'a9d00000-0000-0000-0000-000000000004');

SELECT set_config('request.jwt.claims', '{"sub":"a9a00000-0000-0000-0000-000000000001","supabase_uid":"a9a00000-0000-0000-0000-000000000001"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  P CONSTANT UUID := 'a9b00000-0000-0000-0000-000000000002';
  D CONSTANT UUID := 'a9c00000-0000-0000-0000-000000000002';
  L CONSTANT UUID := 'a9d00000-0000-0000-0000-000000000003';
  H CONSTANT UUID := 'a9d00000-0000-0000-0000-000000000004';
  c JSONB;
  item RECORD;
  bad JSONB;
BEGIN
  -- single
  c := public.llm_error_context(P, D, 's', L, H, 'comparacao', 'a9e00000-0000-0000-0000-000000000011');
  IF c IS NULL THEN RAISE EXCEPTION 'FALHOU: contexto de single ausente'; END IF;
  IF c->'source' ? 'schema_revision' THEN RAISE EXCEPTION 'FALHOU: contexto ainda carrega schema_revision'; END IF;
  BEGIN
    PERFORM public.set_error_resolution(P, D, 's', 'researchers_correct', c, NULL, NULL, NULL, NULL);
    RAISE EXCEPTION 'FALHOU: Erro do LLM sem valor foi aceito';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  FOREACH bad IN ARRAY ARRAY['"C"'::JSONB, '""'::JSONB, '["A"]'::JSONB, '"A "'::JSONB] LOOP
    BEGIN
      PERFORM public.set_error_resolution(P, D, 's', 'researchers_correct', c, NULL, NULL, NULL, bad);
      RAISE EXCEPTION 'FALHOU: single aceitou valor fora das opções: %', bad;
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
  END LOOP;
  PERFORM public.set_error_resolution(P, D, 's', 'researchers_correct', c, NULL, NULL, 'Veredito', '"B "'::JSONB);
  SELECT * INTO item FROM public.read_error_resolutions(P) WHERE field_name = 's';
  IF item.approved_value IS DISTINCT FROM '"B "'::JSONB OR item.decision <> 'researchers_correct'
    OR item.current_context IS DISTINCT FROM item.context THEN
    RAISE EXCEPTION 'FALHOU: single não devolveu approved_value válido';
  END IF;
  -- Erro humano continua sem valor proprio: o LLM e a fonte.
  PERFORM public.set_error_resolution(P, D, 's', 'llm_correct', c, item.id, item.resolved_at, NULL, '"B "'::JSONB);
  SELECT * INTO item FROM public.read_error_resolutions(P) WHERE field_name = 's';
  IF item.approved_value IS NOT NULL THEN RAISE EXCEPTION 'FALHOU: llm_correct gravou approved_value'; END IF;
  -- Ambos corretos: nao aprova valor, mesmo que o chamador mande um.
  PERFORM public.set_error_resolution(P, D, 's', 'both_correct', c, item.id, item.resolved_at, 'Sinonimos', '"B "'::JSONB);
  SELECT * INTO item FROM public.read_error_resolutions(P) WHERE field_name = 's';
  IF item.decision <> 'both_correct' OR item.approved_value IS NOT NULL OR item.note <> 'Sinonimos'
    OR item.current_context IS DISTINCT FROM item.context THEN
    RAISE EXCEPTION 'FALHOU: both_correct não gravou decisão sem valor';
  END IF;
  -- Todos errados: exige valor, com a mesma validacao por tipo de Erro do LLM.
  BEGIN
    PERFORM public.set_error_resolution(P, D, 's', 'all_wrong', c, item.id, item.resolved_at, NULL, NULL);
    RAISE EXCEPTION 'FALHOU: Todos errados sem valor foi aceito';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.set_error_resolution(P, D, 's', 'all_wrong', c, item.id, item.resolved_at, NULL, '"C"'::JSONB);
    RAISE EXCEPTION 'FALHOU: Todos errados aceitou valor fora das opções';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  PERFORM public.set_error_resolution(P, D, 's', 'all_wrong', c, item.id, item.resolved_at, NULL, '"A"'::JSONB);
  SELECT * INTO item FROM public.read_error_resolutions(P) WHERE field_name = 's';
  IF item.decision <> 'all_wrong' OR item.approved_value IS DISTINCT FROM '"A"'::JSONB THEN
    RAISE EXCEPTION 'FALHOU: all_wrong não gravou o valor escolhido';
  END IF;
  BEGIN
    PERFORM public.set_error_resolution(P, D, 's', 'nobody_knows', c, item.id, item.resolved_at, NULL, NULL);
    RAISE EXCEPTION 'FALHOU: decisão desconhecida foi aceita';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  -- As decisoes que declaram o LLM correto exigem que a resposta dele contenha
  -- o campo; "Todos errados" e "Erro do LLM" nao dependem disso.
  c := public.llm_error_context(P, D, 'n', L, H, 'comparacao', 'a9e00000-0000-0000-0000-000000000018');
  IF c IS NULL OR (c->'llm_value'->>'present')::BOOLEAN THEN
    RAISE EXCEPTION 'FALHOU: fixture deveria ter o campo n ausente na resposta do LLM';
  END IF;
  FOREACH bad IN ARRAY ARRAY['"llm_correct"'::JSONB, '"both_correct"'::JSONB] LOOP
    BEGIN
      PERFORM public.set_error_resolution(P, D, 'n', bad #>> '{}', c, NULL, NULL, NULL, NULL);
      RAISE EXCEPTION 'FALHOU: % aceito sem resposta do LLM no campo', bad;
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
  END LOOP;
  PERFORM public.set_error_resolution(P, D, 'n', 'all_wrong', c, NULL, NULL, NULL, '"Terceira"'::JSONB);
  c := public.llm_error_context(P, D, 's', L, H, 'comparacao', 'a9e00000-0000-0000-0000-000000000011');
  RAISE NOTICE 'OK: both_correct sem valor, all_wrong com valor validado';
  -- e volta a Erro do LLM, para os blocos de invalidacao abaixo.
  PERFORM public.set_error_resolution(P, D, 's', 'researchers_correct', c, item.id, item.resolved_at, NULL, '"B "'::JSONB);

  -- multi
  c := public.llm_error_context(P, D, 'm', L, H, 'comparacao', 'a9e00000-0000-0000-0000-000000000012');
  FOREACH bad IN ARRAY ARRAY['[]'::JSONB, '["A","Z"]'::JSONB, '"A"'::JSONB, '[1]'::JSONB] LOOP
    BEGIN
      PERFORM public.set_error_resolution(P, D, 'm', 'researchers_correct', c, NULL, NULL, NULL, bad);
      RAISE EXCEPTION 'FALHOU: multi aceitou valor inválido: %', bad;
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
  END LOOP;
  PERFORM public.set_error_resolution(P, D, 'm', 'researchers_correct', c, NULL, NULL, NULL, '["C","A"]'::JSONB);
  SELECT * INTO item FROM public.read_error_resolutions(P) WHERE field_name = 'm';
  IF item.approved_value IS DISTINCT FROM '["C","A"]'::JSONB THEN RAISE EXCEPTION 'FALHOU: multi não gravou o subconjunto'; END IF;

  -- grupo de subcampos
  c := public.llm_error_context(P, D, 'g', L, H, 'comparacao', 'a9e00000-0000-0000-0000-000000000013');
  FOREACH bad IN ARRAY ARRAY['{"anos":"2","dias":"1"}'::JSONB, '{"anos":""}'::JSONB, '""'::JSONB, '[]'::JSONB] LOOP
    BEGIN
      PERFORM public.set_error_resolution(P, D, 'g', 'researchers_correct', c, NULL, NULL, NULL, bad);
      RAISE EXCEPTION 'FALHOU: grupo aceitou valor inválido: %', bad;
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
  END LOOP;
  PERFORM public.set_error_resolution(P, D, 'g', 'researchers_correct', c, NULL, NULL, NULL, '{"anos":"2"}'::JSONB);
  SELECT * INTO item FROM public.read_error_resolutions(P) WHERE field_name = 'g';
  IF item.approved_value IS DISTINCT FROM '{"anos":"2"}'::JSONB THEN RAISE EXCEPTION 'FALHOU: grupo não gravou o objeto'; END IF;
  PERFORM public.set_error_resolution(P, D, 'g', 'researchers_correct', c, item.id, item.resolved_at, NULL, '"Não informada"'::JSONB);

  -- texto livre
  c := public.llm_error_context(P, D, 't', L, H, 'comparacao', 'a9e00000-0000-0000-0000-000000000014');
  BEGIN
    PERFORM public.set_error_resolution(P, D, 't', 'researchers_correct', c, NULL, NULL, NULL, '" "'::JSONB);
    RAISE EXCEPTION 'FALHOU: texto vazio foi aceito';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  PERFORM public.set_error_resolution(P, D, 't', 'researchers_correct', c, NULL, NULL, NULL, '"livre"'::JSONB);

  -- allow_other: fora das opcoes so "Outro: <texto>", com complemento.
  c := public.llm_error_context(P, D, 'o', L, H, 'comparacao', 'a9e00000-0000-0000-0000-000000000015');
  FOREACH bad IN ARRAY ARRAY['"Outro: "'::JSONB, '"Outro:  "'::JSONB, '"Z"'::JSONB] LOOP
    BEGIN
      PERFORM public.set_error_resolution(P, D, 'o', 'researchers_correct', c, NULL, NULL, NULL, bad);
      RAISE EXCEPTION 'FALHOU: single com allow_other aceitou %', bad;
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
  END LOOP;
  PERFORM public.set_error_resolution(P, D, 'o', 'researchers_correct', c, NULL, NULL, NULL, '"Outro: outra coisa"'::JSONB);
  SELECT * INTO item FROM public.read_error_resolutions(P) WHERE field_name = 'o';
  PERFORM public.set_error_resolution(P, D, 'o', 'researchers_correct', c, item.id, item.resolved_at, NULL, '"A"'::JSONB);
  c := public.llm_error_context(P, D, 'mo', L, H, 'comparacao', 'a9e00000-0000-0000-0000-000000000016');
  FOREACH bad IN ARRAY ARRAY['["Outro: "]'::JSONB, '["ZZZ"]'::JSONB, '["A","Outro: "]'::JSONB] LOOP
    BEGIN
      PERFORM public.set_error_resolution(P, D, 'mo', 'researchers_correct', c, NULL, NULL, NULL, bad);
      RAISE EXCEPTION 'FALHOU: multi com allow_other aceitou %', bad;
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
  END LOOP;
  PERFORM public.set_error_resolution(P, D, 'mo', 'researchers_correct', c, NULL, NULL, NULL, '["A","Outro: y"]'::JSONB);

  -- date: formato parcial, sentinela do campo ou a geral; string solta nao.
  c := public.llm_error_context(P, D, 'd', L, H, 'comparacao', 'a9e00000-0000-0000-0000-000000000017');
  FOREACH bad IN ARRAY ARRAY['"ambiguo"'::JSONB, '"XX/XX/XXXX"'::JSONB, '"2026-02-01"'::JSONB, '""'::JSONB] LOOP
    BEGIN
      PERFORM public.set_error_resolution(P, D, 'd', 'researchers_correct', c, NULL, NULL, NULL, bad);
      RAISE EXCEPTION 'FALHOU: date aceitou %', bad;
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
  END LOOP;
  PERFORM public.set_error_resolution(P, D, 'd', 'researchers_correct', c, NULL, NULL, NULL, '"XX/03/2024"'::JSONB);
  SELECT * INTO item FROM public.read_error_resolutions(P) WHERE field_name = 'd';
  PERFORM public.set_error_resolution(P, D, 'd', 'researchers_correct', c, item.id, item.resolved_at, NULL, '"Sem data"'::JSONB);
  SELECT * INTO item FROM public.read_error_resolutions(P) WHERE field_name = 'd';
  PERFORM public.set_error_resolution(P, D, 'd', 'researchers_correct', c, item.id, item.resolved_at, NULL, '"Não informada"'::JSONB);
  RAISE NOTICE 'OK: Erro do LLM exige e valida o valor por tipo, e o devolve em approved_value';
END $$;
RESET ROLE;

-- Save de schema em OUTRA pergunta (t) nao invalida a decisao de s.
UPDATE public.projects
SET pydantic_fields = jsonb_set(pydantic_fields, '{3,description}', '"Livre editada"'),
    schema_revision = schema_revision + 1
WHERE id = 'a9b00000-0000-0000-0000-000000000002';
SELECT set_config('request.jwt.claims', '{"sub":"a9a00000-0000-0000-0000-000000000001","supabase_uid":"a9a00000-0000-0000-0000-000000000001"}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.read_error_resolutions('a9b00000-0000-0000-0000-000000000002')
                 WHERE field_name = 's' AND current_context = context) THEN
    RAISE EXCEPTION 'FALHOU: save de schema em outra pergunta invalidou a decisão';
  END IF;
  IF EXISTS (SELECT 1 FROM public.read_error_resolutions('a9b00000-0000-0000-0000-000000000002')
             WHERE field_name = 't' AND current_context = context) THEN
    RAISE EXCEPTION 'FALHOU: mudança na própria pergunta (t) não invalidou';
  END IF;
END $$;
RESET ROLE;
-- Mudanca na PROPRIA pergunta (s ganha opcao) invalida.
UPDATE public.projects
SET pydantic_fields = jsonb_set(pydantic_fields, '{0,options}', '["A","B ","C"]'),
    schema_revision = schema_revision + 1
WHERE id = 'a9b00000-0000-0000-0000-000000000002';
SELECT set_config('request.jwt.claims', '{"sub":"a9a00000-0000-0000-0000-000000000001","supabase_uid":"a9a00000-0000-0000-0000-000000000001"}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.read_error_resolutions('a9b00000-0000-0000-0000-000000000002')
             WHERE field_name = 's' AND current_context = context) THEN
    RAISE EXCEPTION 'FALHOU: mudança na própria pergunta (s) não invalidou';
  END IF;
  RAISE NOTICE 'OK: a decisão só invalida quando a própria pergunta muda';
END $$;
RESET ROLE;

-- Regra de reabertura da migration, testada como funcao pura: so afirma
-- divergencia quando pode prova-la.
DO $$
DECLARE
  base CONSTANT JSONB := '{"source":{"kind":"comparacao"},"field_definition":{"type":"single"},"human_value":{"present":true}}';
  ctx JSONB;
BEGIN
  ctx := base #- '{source}' || '{"source":{"kind":"comparacao","verdict":"Sim"},"human_value":{"present":true,"value":"Não"}}';
  IF public.error_resolution_diverges_from_verdict(ctx) IS NOT TRUE THEN RAISE EXCEPTION 'FALHOU: single divergente não foi detectado'; END IF;
  ctx := base || '{"source":{"kind":"comparacao","verdict":"B"},"human_value":{"present":true,"value":"B "}}';
  IF public.error_resolution_diverges_from_verdict(ctx) IS NOT FALSE THEN RAISE EXCEPTION 'FALHOU: espaço final contou como divergência'; END IF;
  ctx := base || '{"source":{"kind":"comparacao","verdict":"Não informada"},"field_definition":{"type":"date"},"human_value":{"present":true,"value":"Não informada"}}';
  IF public.error_resolution_diverges_from_verdict(ctx) IS NOT FALSE THEN RAISE EXCEPTION 'FALHOU: data igual contou como divergência'; END IF;
  ctx := base || '{"source":{"kind":"comparacao","verdict":"{\"A\":true,\"C\":true,\"B\":false}"},"field_definition":{"type":"multi"},"human_value":{"present":true,"value":["C","A"]}}';
  IF public.error_resolution_diverges_from_verdict(ctx) IS NOT FALSE THEN RAISE EXCEPTION 'FALHOU: multi com o mesmo conjunto contou como divergência'; END IF;
  ctx := base || '{"source":{"kind":"comparacao","verdict":"{\"A\":true}"},"field_definition":{"type":"multi"},"human_value":{"present":true,"value":["A","B"]}}';
  IF public.error_resolution_diverges_from_verdict(ctx) IS NOT TRUE THEN RAISE EXCEPTION 'FALHOU: multi divergente não foi detectado'; END IF;
  ctx := base || '{"source":{"kind":"comparacao","verdict":"A, B"},"field_definition":{"type":"multi"},"human_value":{"present":true,"value":["A"]}}';
  IF public.error_resolution_diverges_from_verdict(ctx) IS NOT FALSE THEN RAISE EXCEPTION 'FALHOU: veredito de multi ilegível virou divergência'; END IF;
  ctx := base || '{"source":{"kind":"comparacao","verdict":"anos: 2"},"field_definition":{"type":"text","subfields":[{"key":"anos"}]},"human_value":{"present":true,"value":{"anos":"3"}}}';
  IF public.error_resolution_diverges_from_verdict(ctx) IS NOT FALSE THEN RAISE EXCEPTION 'FALHOU: grupo de subcampos foi comparado com texto renderizado'; END IF;
  ctx := base || '{"source":{"kind":"auto_revisao","final_verdict":"humano"},"human_value":{"present":true,"value":"Sim"}}';
  IF public.error_resolution_diverges_from_verdict(ctx) IS NOT FALSE THEN RAISE EXCEPTION 'FALHOU: auto-revisão foi tratada como divergente'; END IF;
  IF has_function_privilege('authenticated', 'public.error_resolution_diverges_from_verdict(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FALHOU: função interna da migration exposta ao cliente';
  END IF;
  RAISE NOTICE 'OK: a regra de reabertura só afirma divergência quando pode prová-la';
END $$;

-- CHECK: approved_value existe se, e somente se, a decisao escolhe valor
-- (Erro do LLM e Todos errados).
DO $$
BEGIN
  BEGIN
    INSERT INTO public.error_resolutions (project_id, document_id, field_name, resolved_by, decision, context)
    VALUES ('a9b00000-0000-0000-0000-000000000002', 'a9c00000-0000-0000-0000-000000000002', 'zz',
            'a9a00000-0000-0000-0000-000000000001', 'researchers_correct', '{}'::jsonb);
    RAISE EXCEPTION 'FALHOU: Erro do LLM sem approved_value passou no CHECK';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.error_resolutions (project_id, document_id, field_name, resolved_by, decision, context, approved_value)
    VALUES ('a9b00000-0000-0000-0000-000000000002', 'a9c00000-0000-0000-0000-000000000002', 'zz',
            'a9a00000-0000-0000-0000-000000000001', 'discussion', '{}'::jsonb, '"x"'::jsonb);
    RAISE EXCEPTION 'FALHOU: discussão com approved_value passou no CHECK';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.error_resolutions (project_id, document_id, field_name, resolved_by, decision, context)
    VALUES ('a9b00000-0000-0000-0000-000000000002', 'a9c00000-0000-0000-0000-000000000002', 'zz',
            'a9a00000-0000-0000-0000-000000000001', 'all_wrong', '{}'::jsonb);
    RAISE EXCEPTION 'FALHOU: Todos errados sem approved_value passou no CHECK';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.error_resolutions (project_id, document_id, field_name, resolved_by, decision, context, approved_value)
    VALUES ('a9b00000-0000-0000-0000-000000000002', 'a9c00000-0000-0000-0000-000000000002', 'zz',
            'a9a00000-0000-0000-0000-000000000001', 'both_correct', '{}'::jsonb, '"x"'::jsonb);
    RAISE EXCEPTION 'FALHOU: Ambos corretos com approved_value passou no CHECK';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.error_resolutions (project_id, document_id, field_name, resolved_by, decision, context)
    VALUES ('a9b00000-0000-0000-0000-000000000002', 'a9c00000-0000-0000-0000-000000000002', 'zz',
            'a9a00000-0000-0000-0000-000000000001', 'nobody_knows', '{}'::jsonb);
    RAISE EXCEPTION 'FALHOU: decisão desconhecida passou no CHECK';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'OK: CHECK amarra approved_value às decisões que escolhem valor';
END $$;

-- ========== Resposta em branco em pergunta condicional ==========
-- Pergunta condicional que nao foi acionada fica vazia. Nela, e so nela, o
-- vazio canonico ("" ou [] em multi) e valor aprovavel em "Erro do LLM" e
-- "Todos errados", e "Erro humano" aceita o LLM que deixou o campo de fora.
-- "Ambos corretos" continua exigindo a resposta do LLM.
RESET ROLE;
INSERT INTO public.projects (id, name, created_by, automation_mode, pydantic_fields) VALUES
  ('a9b00000-0000-0000-0000-000000000003', 'Decision blank test', 'a9a00000-0000-0000-0000-000000000001', 'compare_llm',
   '[{"name":"g0","type":"single","options":["Sim","Não"],"description":"Gatilho"},
     {"name":"c","type":"single","options":["A","B"],"description":"Condicional","condition":{"field":"g0","equals":"Sim"}},
     {"name":"cm","type":"multi","options":["A","B"],"description":"Condicional múltipla","condition":{"field":"g0","equals":"Sim"}},
     {"name":"cn","type":"single","options":["A","B"],"description":"Sem condição"}]');
INSERT INTO public.documents (id, project_id, title, text) VALUES
  ('a9c00000-0000-0000-0000-000000000003', 'a9b00000-0000-0000-0000-000000000003', 'Documento 3', 'Texto');
INSERT INTO public.responses (id, project_id, document_id, respondent_id, respondent_type, answers) VALUES
  ('a9d00000-0000-0000-0000-000000000005', 'a9b00000-0000-0000-0000-000000000003', 'a9c00000-0000-0000-0000-000000000003', NULL, 'llm',
   '{"g0":"Não","cn":"A"}'),
  ('a9d00000-0000-0000-0000-000000000006', 'a9b00000-0000-0000-0000-000000000003', 'a9c00000-0000-0000-0000-000000000003', 'a9a00000-0000-0000-0000-000000000002', 'humano',
   '{"g0":"Sim","c":"A","cm":["A"],"cn":"B"}');
INSERT INTO public.reviews (id, project_id, document_id, field_name, reviewer_id, verdict, chosen_response_id) VALUES
  ('a9e00000-0000-0000-0000-000000000021', 'a9b00000-0000-0000-0000-000000000003', 'a9c00000-0000-0000-0000-000000000003', 'c', 'a9a00000-0000-0000-0000-000000000002', 'A', 'a9d00000-0000-0000-0000-000000000006'),
  ('a9e00000-0000-0000-0000-000000000022', 'a9b00000-0000-0000-0000-000000000003', 'a9c00000-0000-0000-0000-000000000003', 'cm', 'a9a00000-0000-0000-0000-000000000002', '{"A":true}', 'a9d00000-0000-0000-0000-000000000006'),
  ('a9e00000-0000-0000-0000-000000000023', 'a9b00000-0000-0000-0000-000000000003', 'a9c00000-0000-0000-0000-000000000003', 'cn', 'a9a00000-0000-0000-0000-000000000002', 'B', 'a9d00000-0000-0000-0000-000000000006');

SELECT set_config('request.jwt.claims', '{"sub":"a9a00000-0000-0000-0000-000000000001","supabase_uid":"a9a00000-0000-0000-0000-000000000001"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  P CONSTANT UUID := 'a9b00000-0000-0000-0000-000000000003';
  D CONSTANT UUID := 'a9c00000-0000-0000-0000-000000000003';
  L CONSTANT UUID := 'a9d00000-0000-0000-0000-000000000005';
  H CONSTANT UUID := 'a9d00000-0000-0000-0000-000000000006';
  c JSONB;
  item RECORD;
  bad JSONB;
BEGIN
  c := public.llm_error_context(P, D, 'c', L, H, 'comparacao', 'a9e00000-0000-0000-0000-000000000021');
  IF c IS NULL OR (c->'llm_value'->>'present')::BOOLEAN OR NOT (c->'field_definition' ? 'condition') THEN
    RAISE EXCEPTION 'FALHOU: fixture deveria ter c condicional e ausente na resposta do LLM';
  END IF;
  -- Ambos corretos segue exigindo a resposta do LLM, mesmo em condicional.
  BEGIN
    PERFORM public.set_error_resolution(P, D, 'c', 'both_correct', c, NULL, NULL, NULL, NULL);
    RAISE EXCEPTION 'FALHOU: both_correct aceito sem resposta do LLM em condicional';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  -- JSON null nao e o vazio canonico, e o vazio de outro tipo tambem nao.
  FOREACH bad IN ARRAY ARRAY['null'::JSONB, '[]'::JSONB, '" "'::JSONB] LOOP
    BEGIN
      PERFORM public.set_error_resolution(P, D, 'c', 'all_wrong', c, NULL, NULL, NULL, bad);
      RAISE EXCEPTION 'FALHOU: single condicional aceitou vazio não canônico: %', bad;
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
  END LOOP;
  PERFORM public.set_error_resolution(P, D, 'c', 'all_wrong', c, NULL, NULL, NULL, '""'::JSONB);
  SELECT * INTO item FROM public.read_error_resolutions(P) WHERE field_name = 'c';
  IF item.decision <> 'all_wrong' OR item.approved_value IS DISTINCT FROM '""'::JSONB THEN
    RAISE EXCEPTION 'FALHOU: all_wrong em branco não gravou o vazio';
  END IF;
  -- Erro humano: o LLM deixou a condicional de fora, e isso e a resposta dele.
  PERFORM public.set_error_resolution(P, D, 'c', 'llm_correct', c, item.id, item.resolved_at, NULL, NULL);
  SELECT * INTO item FROM public.read_error_resolutions(P) WHERE field_name = 'c';
  IF item.decision <> 'llm_correct' OR item.approved_value IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU: llm_correct não aceitou LLM ausente em condicional';
  END IF;

  c := public.llm_error_context(P, D, 'cm', L, H, 'comparacao', 'a9e00000-0000-0000-0000-000000000022');
  BEGIN
    PERFORM public.set_error_resolution(P, D, 'cm', 'researchers_correct', c, NULL, NULL, NULL, '""'::JSONB);
    RAISE EXCEPTION 'FALHOU: multi condicional aceitou "" como vazio';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  PERFORM public.set_error_resolution(P, D, 'cm', 'researchers_correct', c, NULL, NULL, NULL, '[]'::JSONB);
  SELECT * INTO item FROM public.read_error_resolutions(P) WHERE field_name = 'cm';
  IF item.approved_value IS DISTINCT FROM '[]'::JSONB THEN
    RAISE EXCEPTION 'FALHOU: multi condicional não gravou []';
  END IF;

  -- Sem condicao, o vazio segue recusado.
  c := public.llm_error_context(P, D, 'cn', L, H, 'comparacao', 'a9e00000-0000-0000-0000-000000000023');
  BEGIN
    PERFORM public.set_error_resolution(P, D, 'cn', 'all_wrong', c, NULL, NULL, NULL, '""'::JSONB);
    RAISE EXCEPTION 'FALHOU: pergunta sem condição aceitou resposta em branco';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  RAISE NOTICE 'OK: resposta em branco só em pergunta condicional';
END $$;

ROLLBACK;
