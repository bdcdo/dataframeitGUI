-- A decisão do LLM Insights cai só quando o hash do campo muda
-- (20260927171000_llm_decision_follows_field_hash.sql).
--
-- Blocos:
--   (a) decisão gravada, schema editado: `read_error_resolutions` devolve o
--       contexto guardado e o recalculado, e `error_resolution_context_current`
--       os julga. `help_text`, `condition`, `required` e `justification_prompt`
--       mudam o contexto e não derrubam a decisão; descrição, opções e o
--       contador de revisão da pergunta mudam o hash e a derrubam. A cópia
--       TypeScript (`contextIsCurrent`) tem os mesmos casos;
--   (b) a regra sobre o JSON: o resto do contexto continua valendo inteiro,
--       sem hash dos dois lados a comparação é a da definição inteira, e
--       contexto ausente nunca é corrente;
--   (c) `set_error_resolution` aceita o contexto pedido antes de uma edição
--       que só esclarece, grava o recalculado, e recusa o pedido antes de
--       uma mudança de hash;
--   (d) grants: a função nova fica fechada para o cliente, e o RPC continua
--       DEFINER com search_path vazio e os grants de antes.
--
-- Roda numa transação e não deixa fixture no banco local.

BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('dec00000-0000-0000-0000-000000000001', 'decision-hash-owner@example.test');
INSERT INTO public.clerk_user_mapping (clerk_user_id, supabase_user_id, access_sync_version)
  SELECT id::TEXT, id, 1 FROM auth.users WHERE id::TEXT LIKE 'dec00000-%';

-- q e q2 são a mesma pergunta em dois campos: q para a leitura (a), q2 para a
-- gravação (c). g0 é o gatilho da condição que o caso (a) acrescenta.
INSERT INTO public.projects (id, name, created_by, automation_mode, pydantic_fields) VALUES
  ('dec10000-0000-0000-0000-000000000001', 'Decision follows hash test', 'dec00000-0000-0000-0000-000000000001', 'compare_llm',
   '[{"id":"dec50000-0000-4000-8000-000000000001","name":"g0","type":"single","options":["Sim","Não"],"description":"Gatilho","hash":"g00000000001"},
     {"id":"dec50000-0000-4000-8000-000000000002","name":"q","type":"single","options":["A","B"],"description":"Pergunta","help_text":"Ajuda","hash":"q00000000001"},
     {"id":"dec50000-0000-4000-8000-000000000003","name":"q2","type":"single","options":["A","B"],"description":"Pergunta","help_text":"Ajuda","hash":"q20000000001"}]');
INSERT INTO public.documents (id, project_id, title, text) VALUES
  ('dec20000-0000-0000-0000-000000000001', 'dec10000-0000-0000-0000-000000000001', 'Documento', 'Texto');
INSERT INTO public.responses (id, project_id, document_id, respondent_id, respondent_type, is_latest, answers) VALUES
  ('dec30000-0000-0000-0000-000000000001', 'dec10000-0000-0000-0000-000000000001', 'dec20000-0000-0000-0000-000000000001', NULL, 'llm', true,
   '{"g0":"Sim","q":"A","q2":"A"}'),
  ('dec30000-0000-0000-0000-000000000002', 'dec10000-0000-0000-0000-000000000001', 'dec20000-0000-0000-0000-000000000001', 'dec00000-0000-0000-0000-000000000001', 'humano', true,
   '{"g0":"Sim","q":"B","q2":"B"}');
INSERT INTO public.reviews (id, project_id, document_id, field_name, reviewer_id, verdict, chosen_response_id) VALUES
  ('dec40000-0000-0000-0000-000000000001', 'dec10000-0000-0000-0000-000000000001', 'dec20000-0000-0000-0000-000000000001', 'q',
   'dec00000-0000-0000-0000-000000000001', 'B', 'dec30000-0000-0000-0000-000000000002'),
  ('dec40000-0000-0000-0000-000000000002', 'dec10000-0000-0000-0000-000000000001', 'dec20000-0000-0000-0000-000000000001', 'q2',
   'dec00000-0000-0000-0000-000000000001', 'B', 'dec30000-0000-0000-0000-000000000002');

-- A edição do schema como o save a faz: o patch entra na definição de um
-- campo e a revisão do schema sobe.
CREATE FUNCTION pg_temp.patch_field(p_name TEXT, p_patch JSONB) RETURNS VOID LANGUAGE sql AS $$
  UPDATE public.projects
  SET pydantic_fields = (
    SELECT jsonb_agg(CASE WHEN f->>'name' = p_name THEN f || p_patch ELSE f END ORDER BY i)
    FROM jsonb_array_elements(pydantic_fields) WITH ORDINALITY AS t(f, i)),
      schema_revision = schema_revision + 1
  WHERE id = 'dec10000-0000-0000-0000-000000000001';
$$;

-- "Erro humano" em q, gravado pelo dono do projeto. A decisão não depende da
-- fonte, então a mudança de hash não a tira de `read_error_resolutions`
-- (o contexto recalculado existe), e o que decide é só a comparação.
SELECT set_config('request.jwt.claims', '{"sub":"dec00000-0000-0000-0000-000000000001","supabase_uid":"dec00000-0000-0000-0000-000000000001"}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  PERFORM public.set_error_resolution('dec10000-0000-0000-0000-000000000001', 'dec20000-0000-0000-0000-000000000001', 'q', 'llm_correct',
    public.llm_error_context('dec10000-0000-0000-0000-000000000001', 'dec20000-0000-0000-0000-000000000001', 'q',
      'dec30000-0000-0000-0000-000000000001', 'dec30000-0000-0000-0000-000000000002', 'comparacao', 'dec40000-0000-0000-0000-000000000001'),
    NULL, NULL);
END $$;
RESET ROLE;

-- (a) Cada edição parte do schema original.
DO $$
DECLARE
  P CONSTANT UUID := 'dec10000-0000-0000-0000-000000000001';
  v_base JSONB;
  kase RECORD;
  item RECORD;
BEGIN
  SELECT pydantic_fields INTO v_base FROM public.projects WHERE id = P;
  FOR kase IN SELECT * FROM (VALUES
      ('help_text que só esclarece', '{"help_text":"Ajuda reescrita"}'::JSONB, true),
      ('condição nova', '{"condition":{"field":"g0","equals":"Sim"}}'::JSONB, true),
      ('required', '{"required":true}'::JSONB, true),
      ('justification_prompt', '{"justification_prompt":"Por quê?"}'::JSONB, true),
      ('descrição nova, hash novo', '{"description":"Outra pergunta","hash":"q00000000002"}'::JSONB, false),
      ('opções novas, hash novo', '{"options":["A","B","C"],"hash":"q00000000003"}'::JSONB, false),
      ('revisão da pergunta, hash novo', '{"question_revision":1,"hash":"q00000000004"}'::JSONB, false)
    ) AS v(label, patch, expected) LOOP
    PERFORM pg_temp.patch_field('q', kase.patch);
    SELECT * INTO item FROM public.read_error_resolutions(P) AS r WHERE r.field_name = 'q';
    IF item.context IS NULL OR item.current_context IS NULL THEN
      RAISE EXCEPTION 'FALHOU: % deixou a decisão sem contexto recalculado', kase.label;
    END IF;
    -- Sem esta guarda o caso passaria sem exercitar nada: a regra anterior,
    -- de contexto idêntico, também derrubaria todos eles.
    IF item.current_context = item.context THEN
      RAISE EXCEPTION 'FALHOU: % não mudou o contexto recalculado', kase.label;
    END IF;
    IF public.error_resolution_context_current(item.context, item.current_context) IS DISTINCT FROM kase.expected THEN
      RAISE EXCEPTION 'FALHOU: % deixou a decisão % (esperado %)', kase.label,
        CASE WHEN kase.expected THEN 'inválida' ELSE 'válida' END,
        CASE WHEN kase.expected THEN 'válida' ELSE 'inválida' END;
    END IF;
    UPDATE public.projects SET pydantic_fields = v_base, schema_revision = schema_revision + 1 WHERE id = P;
  END LOOP;
  RAISE NOTICE 'OK: a decisão fica com edição fora do hash e cai com mudança de hash';
END $$;

-- (b) A regra sobre o JSON.
DO $$
DECLARE
  v_ctx CONSTANT JSONB := '{"project_id":"p","source":{"kind":"comparacao","id":"r"},
    "human_value":{"present":true,"value":"B"},
    "field_definition":{"name":"q","type":"single","options":["A","B"],"description":"Pergunta","help_text":"Ajuda","hash":"h1"}}';
  v_unhashed JSONB := v_ctx #- '{field_definition,hash}';
BEGIN
  IF public.error_resolution_context_current(v_ctx, jsonb_set(v_ctx, '{field_definition,help_text}', '"Outra"')) IS NOT TRUE THEN
    RAISE EXCEPTION 'FALHOU: help_text com o mesmo hash derrubou o contexto';
  END IF;
  -- O hash manda sobre a definição: mesmo hash, mesma pergunta.
  IF public.error_resolution_context_current(v_ctx, jsonb_set(v_ctx, '{field_definition,hash}', '"h2"')) IS NOT FALSE THEN
    RAISE EXCEPTION 'FALHOU: hash diferente não derrubou o contexto';
  END IF;
  IF public.error_resolution_context_current(v_ctx, jsonb_set(v_ctx, '{human_value,value}', '"C"')) IS NOT FALSE THEN
    RAISE EXCEPTION 'FALHOU: resposta humana mudada com o mesmo hash não derrubou o contexto';
  END IF;
  IF public.error_resolution_context_current(v_ctx, jsonb_set(v_ctx, '{source,id}', '"outra"')) IS NOT FALSE THEN
    RAISE EXCEPTION 'FALHOU: fonte trocada com o mesmo hash não derrubou o contexto';
  END IF;
  -- Sem hash dos dois lados, ou de um deles, vale a definição inteira.
  IF public.error_resolution_context_current(v_unhashed, v_unhashed) IS NOT TRUE THEN
    RAISE EXCEPTION 'FALHOU: definição sem hash e idêntica derrubou o contexto';
  END IF;
  IF public.error_resolution_context_current(v_unhashed, jsonb_set(v_unhashed, '{field_definition,help_text}', '"Outra"')) IS NOT FALSE THEN
    RAISE EXCEPTION 'FALHOU: sem hash, help_text mudado não derrubou o contexto';
  END IF;
  IF public.error_resolution_context_current(v_unhashed, v_ctx) IS NOT FALSE
     OR public.error_resolution_context_current(v_ctx, v_unhashed) IS NOT FALSE THEN
    RAISE EXCEPTION 'FALHOU: hash de um lado só não caiu para a definição inteira';
  END IF;
  -- Contexto ausente (fonte que sumiu) ou que não é objeto: falso, não NULL.
  IF public.error_resolution_context_current(v_ctx, NULL) IS NOT FALSE
     OR public.error_resolution_context_current(NULL, v_ctx) IS NOT FALSE
     OR public.error_resolution_context_current(v_ctx, '[]') IS NOT FALSE THEN
    RAISE EXCEPTION 'FALHOU: contexto ausente não deu falso';
  END IF;
  RAISE NOTICE 'OK: regra sobre o JSON';
END $$;

-- (c) set_error_resolution. O contexto é pedido antes da edição, como o
-- diálogo faz ao abrir, e confirmado depois dela.
CREATE TEMP TABLE hash_requested (label TEXT PRIMARY KEY, context JSONB) ON COMMIT DROP;
GRANT ALL ON hash_requested TO authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"dec00000-0000-0000-0000-000000000001","supabase_uid":"dec00000-0000-0000-0000-000000000001"}', true);
SET LOCAL ROLE authenticated;
INSERT INTO hash_requested SELECT 'antes do help_text', public.llm_error_context(
  'dec10000-0000-0000-0000-000000000001', 'dec20000-0000-0000-0000-000000000001', 'q2',
  'dec30000-0000-0000-0000-000000000001', 'dec30000-0000-0000-0000-000000000002', 'comparacao', 'dec40000-0000-0000-0000-000000000002');
RESET ROLE;
SELECT pg_temp.patch_field('q2', '{"help_text":"Ajuda reescrita"}');
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  P CONSTANT UUID := 'dec10000-0000-0000-0000-000000000001';
  D CONSTANT UUID := 'dec20000-0000-0000-0000-000000000001';
  item RECORD;
BEGIN
  PERFORM public.set_error_resolution(P, D, 'q2', 'llm_correct',
    (SELECT context FROM hash_requested WHERE label = 'antes do help_text'), NULL, NULL);
  SELECT * INTO item FROM public.read_error_resolutions(P) AS r WHERE r.field_name = 'q2';
  IF item.decision IS DISTINCT FROM 'llm_correct' THEN
    RAISE EXCEPTION 'FALHOU: a decisão pedida antes de um help_text que só esclarece não foi gravada';
  END IF;
  -- O gravado é o recalculado, com a definição atual inteira.
  IF item.context->'field_definition'->>'help_text' IS DISTINCT FROM 'Ajuda reescrita'
     OR item.context IS DISTINCT FROM item.current_context THEN
    RAISE EXCEPTION 'FALHOU: a decisão gravou o contexto pedido, e não o recalculado';
  END IF;
  PERFORM public.set_error_resolution(P, D, 'q2', NULL, NULL, item.id, item.resolved_at);
END $$;
INSERT INTO hash_requested SELECT 'antes da descrição', public.llm_error_context(
  'dec10000-0000-0000-0000-000000000001', 'dec20000-0000-0000-0000-000000000001', 'q2',
  'dec30000-0000-0000-0000-000000000001', 'dec30000-0000-0000-0000-000000000002', 'comparacao', 'dec40000-0000-0000-0000-000000000002');
RESET ROLE;
SELECT pg_temp.patch_field('q2', '{"description":"Outra pergunta","hash":"q20000000002"}');
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.set_error_resolution('dec10000-0000-0000-0000-000000000001', 'dec20000-0000-0000-0000-000000000001', 'q2', 'llm_correct',
      (SELECT context FROM hash_requested WHERE label = 'antes da descrição'), NULL, NULL);
    RAISE EXCEPTION 'FALHOU: a decisão pedida antes de uma mudança de hash foi gravada';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
  RAISE NOTICE 'OK: set_error_resolution segue a mesma regra';
END $$;
RESET ROLE;

-- (d) Grants e atributos.
DO $$
DECLARE
  v_proc RECORD;
BEGIN
  IF has_function_privilege('authenticated', 'public.error_resolution_context_current(jsonb,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.error_resolution_context_current(jsonb,jsonb)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.error_resolution_context_current(jsonb,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FALHOU: error_resolution_context_current exposta ao cliente';
  END IF;
  SELECT p.prosecdef, p.proconfig INTO v_proc FROM pg_proc p
  WHERE p.oid = 'public.set_error_resolution(uuid,uuid,text,text,jsonb,uuid,timestamptz,text,jsonb)'::regprocedure;
  IF NOT v_proc.prosecdef OR v_proc.proconfig IS DISTINCT FROM ARRAY['search_path=""'] THEN
    RAISE EXCEPTION 'FALHOU: set_error_resolution perdeu SECURITY DEFINER ou o search_path (%)', v_proc.proconfig;
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.set_error_resolution(uuid,uuid,text,text,jsonb,uuid,timestamptz,text,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.set_error_resolution(uuid,uuid,text,text,jsonb,uuid,timestamptz,text,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FALHOU: grants de set_error_resolution mudaram';
  END IF;
  RAISE NOTICE 'OK: grants';
END $$;

ROLLBACK;
