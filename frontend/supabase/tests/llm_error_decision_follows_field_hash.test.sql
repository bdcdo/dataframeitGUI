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
--   (d) grants: as funções novas ficam fechadas para o cliente, e o RPC continua
--       DEFINER com search_path vazio e os grants de antes;
--   (e) o valor é julgado pela definição atual na gravação: o branco pedido
--       antes de a pergunta perder a condição é recusado, e a resposta do LLM
--       que "Erro humano" aprova precisa estar no domínio atual
--       (`review_verdict_in_domain`), em `single` e em `multi`;
--   (f) o branco pedido diante de uma condição e confirmado depois de ela ser
--       trocada é recusado, porque o contexto gravado traria a condição nova
--       e a leitura o daria como valendo; o valor não branco continua
--       gravando. O branco é o da leitura (`isBlankAnswer`): texto só de tab
--       ou NBSP conta, e "Ambos corretos" com branco comum também cai. Sem a
--       chave `condition` e `condition: null` são a mesma pergunta sem
--       condição.
--
-- Roda numa transação e não deixa fixture no banco local.

BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('dec00000-0000-0000-0000-000000000001', 'decision-hash-owner@example.test');
INSERT INTO public.clerk_user_mapping (clerk_user_id, supabase_user_id, access_sync_version)
  SELECT id::TEXT, id, 1 FROM auth.users WHERE id::TEXT LIKE 'dec00000-%';

-- q e q2 são a mesma pergunta em dois campos: q para a leitura (a), q2 para a
-- gravação (c). g0 é o gatilho da condição que o caso (a) acrescenta. q3, q4
-- e q5 servem ao bloco (e): q3 é condicional e o LLM a deixa de fora, q4 e q5
-- aceitam "Outro" e o LLM responde com ele. q6 e q7 servem ao bloco (f): as
-- duas são condicionais, o LLM deixa q6 de fora e responde q7.
INSERT INTO public.projects (id, name, created_by, automation_mode, pydantic_fields) VALUES
  ('dec10000-0000-0000-0000-000000000001', 'Decision follows hash test', 'dec00000-0000-0000-0000-000000000001', 'compare_llm',
   '[{"id":"dec50000-0000-4000-8000-000000000001","name":"g0","type":"single","options":["Sim","Não"],"description":"Gatilho","hash":"g00000000001"},
     {"id":"dec50000-0000-4000-8000-000000000002","name":"q","type":"single","options":["A","B"],"description":"Pergunta","help_text":"Ajuda","hash":"q00000000001"},
     {"id":"dec50000-0000-4000-8000-000000000003","name":"q2","type":"single","options":["A","B"],"description":"Pergunta","help_text":"Ajuda","hash":"q20000000001"},
     {"id":"dec50000-0000-4000-8000-000000000004","name":"q3","type":"text","description":"Condicional","condition":{"field":"g0","equals":"Sim"},"hash":"q30000000001"},
     {"id":"dec50000-0000-4000-8000-000000000005","name":"q4","type":"single","options":["A","B"],"allow_other":true,"description":"Com Outro","hash":"q40000000001"},
     {"id":"dec50000-0000-4000-8000-000000000006","name":"q5","type":"multi","options":["A","B"],"allow_other":true,"description":"Várias com Outro","hash":"q50000000001"},
     {"id":"dec50000-0000-4000-8000-000000000007","name":"q6","type":"text","description":"Condicional trocada","condition":{"field":"g0","equals":"Sim"},"hash":"q60000000001"},
     {"id":"dec50000-0000-4000-8000-000000000008","name":"q7","type":"text","description":"Condicional trocada, respondida","condition":{"field":"g0","equals":"Sim"},"hash":"q70000000001"}]');
INSERT INTO public.documents (id, project_id, title, text) VALUES
  ('dec20000-0000-0000-0000-000000000001', 'dec10000-0000-0000-0000-000000000001', 'Documento', 'Texto');
INSERT INTO public.responses (id, project_id, document_id, respondent_id, respondent_type, is_latest, answers) VALUES
  ('dec30000-0000-0000-0000-000000000001', 'dec10000-0000-0000-0000-000000000001', 'dec20000-0000-0000-0000-000000000001', NULL, 'llm', true,
   '{"g0":"Sim","q":"A","q2":"A","q4":"Outro: C","q5":["A","Outro: C"],"q7":"Do LLM"}'),
  ('dec30000-0000-0000-0000-000000000002', 'dec10000-0000-0000-0000-000000000001', 'dec20000-0000-0000-0000-000000000001', 'dec00000-0000-0000-0000-000000000001', 'humano', true,
   '{"g0":"Sim","q":"B","q2":"B","q3":"Texto","q4":"B","q5":["B"],"q6":"Texto","q7":"Texto"}');
INSERT INTO public.reviews (id, project_id, document_id, field_name, reviewer_id, verdict, chosen_response_id) VALUES
  ('dec40000-0000-0000-0000-000000000001', 'dec10000-0000-0000-0000-000000000001', 'dec20000-0000-0000-0000-000000000001', 'q',
   'dec00000-0000-0000-0000-000000000001', 'B', 'dec30000-0000-0000-0000-000000000002'),
  ('dec40000-0000-0000-0000-000000000002', 'dec10000-0000-0000-0000-000000000001', 'dec20000-0000-0000-0000-000000000001', 'q2',
   'dec00000-0000-0000-0000-000000000001', 'B', 'dec30000-0000-0000-0000-000000000002'),
  ('dec40000-0000-0000-0000-000000000003', 'dec10000-0000-0000-0000-000000000001', 'dec20000-0000-0000-0000-000000000001', 'q3',
   'dec00000-0000-0000-0000-000000000001', 'Texto', 'dec30000-0000-0000-0000-000000000002'),
  ('dec40000-0000-0000-0000-000000000004', 'dec10000-0000-0000-0000-000000000001', 'dec20000-0000-0000-0000-000000000001', 'q4',
   'dec00000-0000-0000-0000-000000000001', 'B', 'dec30000-0000-0000-0000-000000000002'),
  ('dec40000-0000-0000-0000-000000000005', 'dec10000-0000-0000-0000-000000000001', 'dec20000-0000-0000-0000-000000000001', 'q5',
   'dec00000-0000-0000-0000-000000000001', '{"B": true}', 'dec30000-0000-0000-0000-000000000002'),
  ('dec40000-0000-0000-0000-000000000006', 'dec10000-0000-0000-0000-000000000001', 'dec20000-0000-0000-0000-000000000001', 'q6',
   'dec00000-0000-0000-0000-000000000001', 'Texto', 'dec30000-0000-0000-0000-000000000002'),
  ('dec40000-0000-0000-0000-000000000007', 'dec10000-0000-0000-0000-000000000001', 'dec20000-0000-0000-0000-000000000001', 'q7',
   'dec00000-0000-0000-0000-000000000001', 'Texto', 'dec30000-0000-0000-0000-000000000002');

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

-- (e) O valor pela definição atual. Cada contexto é pedido antes da edição,
-- que não muda o hash, e confirmado depois dela.
CREATE FUNCTION pg_temp.requested(p_field TEXT, p_review UUID) RETURNS JSONB LANGUAGE sql AS $$
  SELECT public.llm_error_context('dec10000-0000-0000-0000-000000000001', 'dec20000-0000-0000-0000-000000000001', p_field,
    'dec30000-0000-0000-0000-000000000001', 'dec30000-0000-0000-0000-000000000002', 'comparacao', p_review);
$$;
-- Grava e reabre; devolve a mensagem da recusa, ou NULL quando gravou.
CREATE FUNCTION pg_temp.try_decide(p_field TEXT, p_decision TEXT, p_context JSONB, p_value JSONB DEFAULT NULL)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_saved JSONB;
BEGIN
  v_saved := public.set_error_resolution('dec10000-0000-0000-0000-000000000001', 'dec20000-0000-0000-0000-000000000001',
    p_field, p_decision, p_context, NULL, NULL, NULL, p_value);
  PERFORM public.set_error_resolution('dec10000-0000-0000-0000-000000000001', 'dec20000-0000-0000-0000-000000000001',
    p_field, NULL, NULL, (v_saved->>'id')::UUID, (v_saved->>'resolved_at')::TIMESTAMPTZ);
  RETURN NULL;
EXCEPTION WHEN invalid_parameter_value THEN RETURN SQLERRM;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.requested(TEXT, UUID), pg_temp.try_decide(TEXT, TEXT, JSONB, JSONB) TO authenticated;

SET LOCAL ROLE authenticated;
INSERT INTO hash_requested VALUES
  ('q3 condicional', pg_temp.requested('q3', 'dec40000-0000-0000-0000-000000000003')),
  ('q4 com Outro', pg_temp.requested('q4', 'dec40000-0000-0000-0000-000000000004')),
  ('q5 com Outro', pg_temp.requested('q5', 'dec40000-0000-0000-0000-000000000005'));
DO $$
BEGIN
  -- Controle: antes da edição, as mesmas decisões gravam.
  IF pg_temp.try_decide('q3', 'llm_correct', (SELECT context FROM hash_requested WHERE label = 'q3 condicional')) IS NOT NULL
     OR pg_temp.try_decide('q4', 'llm_correct', (SELECT context FROM hash_requested WHERE label = 'q4 com Outro')) IS NOT NULL
     OR pg_temp.try_decide('q5', 'llm_correct', (SELECT context FROM hash_requested WHERE label = 'q5 com Outro')) IS NOT NULL
     OR pg_temp.try_decide('q4', 'researchers_correct', (SELECT context FROM hash_requested WHERE label = 'q4 com Outro'), '"Outro: D"') IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU: a decisão foi recusada antes da edição';
  END IF;
END $$;
RESET ROLE;
UPDATE public.projects
SET pydantic_fields = (
  SELECT jsonb_agg(CASE WHEN f->>'name' = 'q3' THEN f - 'condition' ELSE f END ORDER BY i)
  FROM jsonb_array_elements(pydantic_fields) WITH ORDINALITY AS t(f, i)),
    schema_revision = schema_revision + 1
WHERE id = 'dec10000-0000-0000-0000-000000000001';
SELECT pg_temp.patch_field('q4', '{"allow_other":false}');
SELECT pg_temp.patch_field('q5', '{"allow_other":false}');
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_problem TEXT;
BEGIN
  v_problem := pg_temp.try_decide('q3', 'llm_correct', (SELECT context FROM hash_requested WHERE label = 'q3 condicional'));
  IF v_problem IS DISTINCT FROM 'A resposta do LLM não contém este campo.' THEN
    RAISE EXCEPTION 'FALHOU: Erro humano gravou o branco numa pergunta que perdeu a condição (%)', v_problem;
  END IF;
  v_problem := pg_temp.try_decide('q3', 'researchers_correct', (SELECT context FROM hash_requested WHERE label = 'q3 condicional'), '""');
  IF v_problem IS NULL THEN
    RAISE EXCEPTION 'FALHOU: Erro do LLM gravou o branco numa pergunta que perdeu a condição';
  END IF;
  FOREACH v_problem IN ARRAY ARRAY[
      pg_temp.try_decide('q4', 'llm_correct', (SELECT context FROM hash_requested WHERE label = 'q4 com Outro')),
      pg_temp.try_decide('q5', 'llm_correct', (SELECT context FROM hash_requested WHERE label = 'q5 com Outro'))] LOOP
    IF v_problem IS DISTINCT FROM 'A resposta do LLM está fora das opções atuais da pergunta: escolha "Erro do LLM" ou "Todos errados".' THEN
      RAISE EXCEPTION 'FALHOU: Erro humano gravou a resposta do LLM fora do domínio atual (%)', v_problem;
    END IF;
  END LOOP;
  IF pg_temp.try_decide('q4', 'researchers_correct', (SELECT context FROM hash_requested WHERE label = 'q4 com Outro'), '"Outro: D"') IS NULL THEN
    RAISE EXCEPTION 'FALHOU: Erro do LLM gravou Outro depois que allow_other foi desligado';
  END IF;
  -- A resposta do LLM dentro das opções continua aprovável.
  IF pg_temp.try_decide('q4', 'researchers_correct', (SELECT context FROM hash_requested WHERE label = 'q4 com Outro'), '"A"') IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU: a guarda recusou um valor das opções atuais';
  END IF;
  RAISE NOTICE 'OK: o valor é julgado pela definição atual na gravação';
END $$;
RESET ROLE;

-- (f) A condição trocada entre o pedido e a confirmação. O hash não muda, então
-- o contexto pedido continua corrente; o que decide é o branco.
SET LOCAL ROLE authenticated;
INSERT INTO hash_requested VALUES
  ('q6 antes da troca', pg_temp.requested('q6', 'dec40000-0000-0000-0000-000000000006')),
  ('q7 antes da troca', pg_temp.requested('q7', 'dec40000-0000-0000-0000-000000000007'));
DO $$
BEGIN
  -- Controle: antes da troca, o branco grava.
  IF pg_temp.try_decide('q6', 'llm_correct', (SELECT context FROM hash_requested WHERE label = 'q6 antes da troca')) IS NOT NULL
     OR pg_temp.try_decide('q7', 'researchers_correct', (SELECT context FROM hash_requested WHERE label = 'q7 antes da troca'), '""') IS NOT NULL
     OR pg_temp.try_decide('q7', 'all_wrong', (SELECT context FROM hash_requested WHERE label = 'q7 antes da troca'), '""') IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU: o branco foi recusado antes da troca da condição';
  END IF;
END $$;
RESET ROLE;
SELECT pg_temp.patch_field('q6', '{"condition":{"field":"g0","equals":"Não"}}');
SELECT pg_temp.patch_field('q7', '{"condition":{"field":"g0","equals":"Não"}}');
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  kase RECORD;
BEGIN
  FOR kase IN SELECT * FROM (VALUES
      ('Erro humano', 'q6', 'llm_correct', NULL::JSONB), ('Erro do LLM', 'q7', 'researchers_correct', '""'::JSONB),
      ('Todos errados', 'q7', 'all_wrong', '""'::JSONB),
      ('Erro do LLM com tab', 'q7', 'researchers_correct', to_jsonb(E'\t'::TEXT)),
      ('Erro do LLM com NBSP', 'q7', 'researchers_correct', to_jsonb(E'\u00A0'::TEXT)),
      ('Todos errados com tab', 'q7', 'all_wrong', to_jsonb(E'\t'::TEXT)),
      ('Todos errados com NBSP', 'q7', 'all_wrong', to_jsonb(E'\u00A0'::TEXT)),
      ('Ambos corretos com branco comum', 'q6', 'both_correct', '""'::JSONB)) AS v(label, field, decision, value) LOOP
    BEGIN
      PERFORM pg_temp.try_decide(kase.field, kase.decision,
        (SELECT context FROM hash_requested WHERE label = kase.field || ' antes da troca'), kase.value);
      RAISE EXCEPTION 'FALHOU: % gravou o branco pedido antes da troca da condição', kase.label;
    EXCEPTION WHEN serialization_failure THEN
      IF SQLERRM IS DISTINCT FROM 'A condição da pergunta mudou. Recarregue antes de confirmar.' THEN
        RAISE EXCEPTION 'FALHOU: % recusou o branco com outra mensagem (%)', kase.label, SQLERRM;
      END IF;
    END;
  END LOOP;
  -- O valor não branco não depende da condição: o gate do export confere se a
  -- pergunta se aplica.
  IF pg_temp.try_decide('q7', 'researchers_correct', (SELECT context FROM hash_requested WHERE label = 'q7 antes da troca'), '"Texto"') IS NOT NULL
     OR pg_temp.try_decide('q7', 'llm_correct', (SELECT context FROM hash_requested WHERE label = 'q7 antes da troca')) IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU: a troca da condição recusou um valor não branco';
  END IF;
  -- O contexto pedido depois da troca grava o branco, inclusive o só de
  -- espaço, que a validação do valor aceita.
  IF pg_temp.try_decide('q6', 'llm_correct', pg_temp.requested('q6', 'dec40000-0000-0000-0000-000000000006')) IS NOT NULL
     OR pg_temp.try_decide('q6', 'both_correct', pg_temp.requested('q6', 'dec40000-0000-0000-0000-000000000006'), '""') IS NOT NULL
     OR pg_temp.try_decide('q7', 'researchers_correct', pg_temp.requested('q7', 'dec40000-0000-0000-0000-000000000007'), to_jsonb(E'\t'::TEXT)) IS NOT NULL
     OR pg_temp.try_decide('q7', 'all_wrong', pg_temp.requested('q7', 'dec40000-0000-0000-0000-000000000007'), to_jsonb(E'\u00A0'::TEXT)) IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU: o branco pedido depois da troca foi recusado';
  END IF;
  RAISE NOTICE 'OK: o branco segue a condição do pedido na gravação';
END $$;
RESET ROLE;

-- Sem a chave e `condition: null`, nos dois sentidos, em q3, que o bloco (e)
-- deixou sem condição. O branco é um tab, que a validação de texto aceita
-- fora de pergunta condicional; com a condição de verdade diferente, ele
-- levaria 40001.
SET LOCAL ROLE authenticated;
INSERT INTO hash_requested VALUES ('q3 sem a chave', pg_temp.requested('q3', 'dec40000-0000-0000-0000-000000000003'));
RESET ROLE;
SELECT pg_temp.patch_field('q3', '{"condition":null}');
SET LOCAL ROLE authenticated;
INSERT INTO hash_requested VALUES ('q3 com null', pg_temp.requested('q3', 'dec40000-0000-0000-0000-000000000003'));
DO $$
BEGIN
  IF (SELECT context #> '{field_definition}' ? 'condition' FROM hash_requested WHERE label = 'q3 sem a chave')
     OR (SELECT context #> '{field_definition,condition}' FROM hash_requested WHERE label = 'q3 com null') IS DISTINCT FROM 'null'::JSONB THEN
    RAISE EXCEPTION 'FALHOU: o fixture de q3 não tem os dois formatos da condição ausente';
  END IF;
  IF pg_temp.try_decide('q3', 'researchers_correct', (SELECT context FROM hash_requested WHERE label = 'q3 sem a chave'), to_jsonb(E'\t'::TEXT)) IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU: o branco pedido sem a chave foi recusado';
  END IF;
EXCEPTION WHEN serialization_failure THEN
  RAISE EXCEPTION 'FALHOU: o branco pedido sem a chave foi recusado diante de condition null (%)', SQLERRM;
END $$;
RESET ROLE;
UPDATE public.projects
SET pydantic_fields = (
  SELECT jsonb_agg(CASE WHEN f->>'name' = 'q3' THEN f - 'condition' ELSE f END ORDER BY i)
  FROM jsonb_array_elements(pydantic_fields) WITH ORDINALITY AS t(f, i)),
    schema_revision = schema_revision + 1
WHERE id = 'dec10000-0000-0000-0000-000000000001';
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF pg_temp.try_decide('q3', 'researchers_correct', (SELECT context FROM hash_requested WHERE label = 'q3 com null'), to_jsonb(E'\t'::TEXT)) IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU: o branco pedido com condition null foi recusado';
  END IF;
  RAISE NOTICE 'OK: sem a chave e condition null são a mesma pergunta sem condição';
EXCEPTION WHEN serialization_failure THEN
  RAISE EXCEPTION 'FALHOU: o branco pedido com condition null foi recusado sem a chave (%)', SQLERRM;
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
  IF has_function_privilege('authenticated', 'public.error_resolution_blank(jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.error_resolution_blank(jsonb)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.error_resolution_blank(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FALHOU: error_resolution_blank exposta ao cliente';
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
