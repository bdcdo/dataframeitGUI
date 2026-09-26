-- Contrato: a mudanca da pergunta derruba os julgamentos presos a respostas.
--
-- Julgamentos: par "=" (`response_equivalences`), auto-revisao
-- (`field_reviews`) e decisao do LLM Insights (`error_resolutions`). Eventos
-- da matriz, um campo do projeto por evento para que um nao contamine o outro:
--   `a` pergunta identica (o schema e salvo, o campo nao muda);
--   `q` pergunta alterada (a descricao muda, logo o hash);
--   `e` resposta editada (o schema nao muda);
--   `r` campo renomeado (vira `r2`);
--   `x` campo removido.
-- A regra de leitura do par "=" diante da pergunta alterada vive no
-- TypeScript (`filterCurrentEquivalencePairs`, com a matriz em
-- `equivalence.test.ts`); aqui entram a escrita do par e o que o banco faz.
--
-- Blocos:
--   (a) catalogo: coluna, gatilhos, grants;
--   (b) matriz de `field_review_question_current`, a mesma de
--       `fieldReviewIsCurrent` em `review-validity.test.ts`;
--   (c) carimbo do ciclo e imutabilidade para o cliente;
--   (d) `record_response_equivalences` so aceita respostas vigentes;
--   (e) matriz julgamento x evento, com o save do schema real;
--   (f) defesas: ciclo carimbado com outra versao que escapou do gatilho cai
--       na view, no reconciliador e em llm_error_context;
--   (g) decisao do LLM Insights cai com a edicao de QUALQUER resposta humana
--       da celula, e o backfill do hash da celula nao derruba decisao viva.
--
-- Roda numa transacao e nao deixa fixture no banco local.

BEGIN;

-- (a) Catalogo.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.field_reviews'::regclass AND attname = 'field_hash'
      AND atttypid = 'text'::regtype AND NOT attnotnull AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.field_review_cycle_history_entries'::regclass AND attname = 'field_hash'
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'FALHOU: field_reviews.field_hash (e a coluna do historico) nao existe';
  END IF;

  IF (
    SELECT count(*) FROM pg_catalog.pg_trigger AS trigger_row
    JOIN pg_catalog.pg_proc AS proc ON proc.oid = trigger_row.tgfoid
    WHERE NOT trigger_row.tgisinternal
      AND ((trigger_row.tgrelid = 'public.field_reviews'::regclass
            AND proc.proname IN ('stamp_field_review_field_hash', 'enforce_field_review_field_hash_immutable'))
        OR (trigger_row.tgrelid = 'public.projects'::regclass
            AND proc.proname = 'archive_judgments_on_question_change'))
  ) <> 3 THEN
    RAISE EXCEPTION 'FALHOU: faltam os gatilhos de carimbo, imutabilidade ou mudanca da pergunta';
  END IF;

  IF has_function_privilege('authenticated', 'public.archive_question_changed_field_reviews(uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.archive_question_changed_field_reviews(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.error_resolution_cell_answers_hash(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.field_review_question_current(text,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.field_review_question_current(text,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.pydantic_field_by_name(jsonb,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FALHOU: grants das funcoes novas';
  END IF;
  RAISE NOTICE 'OK: catalogo';
END;
$$;

-- (b) Matriz da validade do ciclo.
DO $$
DECLARE
  current_field CONSTANT JSONB := '{"name":"q","type":"text","description":"P","hash":"aaaaaaaaaaaa"}';
  field_without_hash CONSTANT JSONB := '{"name":"q","type":"text","description":"P"}';
  item RECORD;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('carimbo igual ao hash atual', 'aaaaaaaaaaaa', current_field, true),
      ('carimbo de outra versao da pergunta', 'ffffffffffff', current_field, false),
      ('campo removido ou renomeado', 'aaaaaaaaaaaa', NULL::JSONB, false),
      ('carimbo NULL (legado)', NULL, current_field, true),
      ('carimbo NULL e campo removido', NULL, NULL::JSONB, false),
      ('campo atual sem hash e ciclo carimbado', 'aaaaaaaaaaaa', field_without_hash, false),
      ('campo atual sem hash e ciclo sem carimbo', NULL, field_without_hash, true)
    ) AS matrix(label, field_hash, field, expected)
  LOOP
    IF public.field_review_question_current(item.field_hash, item.field) IS DISTINCT FROM item.expected THEN
      RAISE EXCEPTION 'FALHOU: caso "%" deveria dar %', item.label, item.expected;
    END IF;
  END LOOP;
  RAISE NOTICE 'OK: matriz da validade do ciclo';
END;
$$;

-- Fixture: um projeto em auto-revisao, seis documentos, um LLM e um humano por
-- documento, divergentes em todo campo, todos na versao atual da pergunta.
INSERT INTO auth.users (id, email) VALUES
  ('7a000000-0000-0000-0000-000000000001', 'pergunta-owner@example.test'),
  ('7a000000-0000-0000-0000-000000000002', 'pergunta-coder@example.test'),
  ('7a000000-0000-0000-0000-000000000003', 'pergunta-coder2@example.test');
INSERT INTO public.clerk_user_mapping (clerk_user_id, supabase_user_id, access_sync_version)
  SELECT id::TEXT, id, 1 FROM auth.users WHERE id::TEXT LIKE '7a000000-%';

INSERT INTO public.projects (id, name, created_by, automation_mode, pydantic_hash, pydantic_fields) VALUES
  ('7a100000-0000-0000-0000-000000000001', 'julgamentos seguem a pergunta',
   '7a000000-0000-0000-0000-000000000001', 'auto_review_llm', 'schema-v1',
   '[{"id":"7af00000-0000-4000-8000-000000000001","name":"a","type":"text","target":"all","description":"Identica","hash":"a00000000001"},
     {"id":"7af00000-0000-4000-8000-000000000002","name":"q","type":"text","target":"all","description":"Alterada","hash":"q00000000001"},
     {"id":"7af00000-0000-4000-8000-000000000003","name":"e","type":"text","target":"all","description":"Editada","hash":"e00000000001"},
     {"id":"7af00000-0000-4000-8000-000000000004","name":"r","type":"text","target":"all","description":"Renomeada","hash":"r00000000001"},
     {"id":"7af00000-0000-4000-8000-000000000005","name":"x","type":"text","target":"all","description":"Removida","hash":"x00000000001"}]');

INSERT INTO public.project_members (project_id, user_id, role) VALUES
  ('7a100000-0000-0000-0000-000000000001', '7a000000-0000-0000-0000-000000000002', 'pesquisador'),
  ('7a100000-0000-0000-0000-000000000001', '7a000000-0000-0000-0000-000000000003', 'pesquisador');

INSERT INTO public.documents (id, project_id, title, text)
SELECT ('7a200000-0000-0000-0000-00000000000' || n)::UUID, '7a100000-0000-0000-0000-000000000001', 'Doc ' || n, 'Texto'
FROM generate_series(1, 6) AS n;

-- LLM …0n, humano …1n, segundo humano …2n (so no documento 6).
INSERT INTO public.responses (id, project_id, document_id, respondent_id, respondent_type, answers, justifications, answer_field_hashes, is_partial)
SELECT ('7a300000-0000-0000-0000-00000000000' || n)::UUID, '7a100000-0000-0000-0000-000000000001',
  ('7a200000-0000-0000-0000-00000000000' || n)::UUID, NULL, 'llm',
  '{"a":"llm","q":"llm","e":"llm","r":"llm","x":"llm"}', '{"a":"porque"}',
  '{"a":"a00000000001","q":"q00000000001","e":"e00000000001","r":"r00000000001","x":"x00000000001"}', false
FROM generate_series(1, 6) AS n;
INSERT INTO public.responses (id, project_id, document_id, respondent_id, respondent_type, answers, answer_field_hashes, is_partial)
SELECT ('7a300000-0000-0000-0000-00000000001' || n)::UUID, '7a100000-0000-0000-0000-000000000001',
  ('7a200000-0000-0000-0000-00000000000' || n)::UUID, '7a000000-0000-0000-0000-000000000002', 'humano',
  '{"a":"humano","q":"humano","e":"humano","r":"humano","x":"humano"}',
  '{"a":"a00000000001","q":"q00000000001","e":"e00000000001","r":"r00000000001","x":"x00000000001"}', false
FROM generate_series(1, 6) AS n;
INSERT INTO public.responses (id, project_id, document_id, respondent_id, respondent_type, answers, answer_field_hashes, is_partial) VALUES
  ('7a300000-0000-0000-0000-000000000026', '7a100000-0000-0000-0000-000000000001',
   '7a200000-0000-0000-0000-000000000006', '7a000000-0000-0000-0000-000000000003', 'humano',
   '{"a":"outro","q":"outro"}', '{"a":"a00000000001","q":"q00000000001"}', false);

-- Documento 7: geracao LLM legada, com mapa de hashes vazio.
INSERT INTO public.documents (id, project_id, title, text) VALUES
  ('7a200000-0000-0000-0000-000000000007', '7a100000-0000-0000-0000-000000000001', 'Doc 7', 'Texto');
INSERT INTO public.responses (id, project_id, document_id, respondent_id, respondent_type, answers, answer_field_hashes, is_partial) VALUES
  ('7a300000-0000-0000-0000-000000000007', '7a100000-0000-0000-0000-000000000001',
   '7a200000-0000-0000-0000-000000000007', NULL, 'llm', '{"a":"llm"}', '{}', false),
  ('7a300000-0000-0000-0000-000000000017', '7a100000-0000-0000-0000-000000000001',
   '7a200000-0000-0000-0000-000000000007', '7a000000-0000-0000-0000-000000000002', 'humano', '{"a":"llm"}', '{}', false);

-- Os INSERTs enfileiraram reconciliacao; a fixture parte do estado reconciliado.
DELETE FROM public.auto_review_reconciliation_requests WHERE project_id = '7a100000-0000-0000-0000-000000000001';

-- Um ciclo por (documento 1..5, campo), todos decididos pelo codificador.
INSERT INTO public.field_reviews (project_id, document_id, field_name, human_response_id, llm_response_id, self_reviewer_id)
SELECT '7a100000-0000-0000-0000-000000000001', ('7a200000-0000-0000-0000-00000000000' || n)::UUID, field_name,
  ('7a300000-0000-0000-0000-00000000001' || n)::UUID, ('7a300000-0000-0000-0000-00000000000' || n)::UUID,
  '7a000000-0000-0000-0000-000000000002'
FROM generate_series(1, 5) AS n, unnest(ARRAY['a', 'q', 'e', 'r', 'x']) AS field_name;
UPDATE public.field_reviews
SET self_verdict = 'admite_erro', self_reviewed_at = now()
WHERE project_id = '7a100000-0000-0000-0000-000000000001';

-- Filas abertas so em `q`: no documento 4 a auto-revisao esta pendente, no 5
-- o ciclo foi contestado e espera a arbitragem, com os assignments que a fila
-- projeta.
UPDATE public.field_reviews SET self_verdict = NULL, self_reviewed_at = NULL
WHERE document_id = '7a200000-0000-0000-0000-000000000004' AND field_name = 'q';
UPDATE public.field_reviews
SET self_verdict = 'contesta_llm', self_justification = 'discordo',
    arbitrator_id = '7a000000-0000-0000-0000-000000000003'
WHERE document_id = '7a200000-0000-0000-0000-000000000005' AND field_name = 'q';
INSERT INTO public.assignments (project_id, document_id, user_id, type, status) VALUES
  ('7a100000-0000-0000-0000-000000000001', '7a200000-0000-0000-0000-000000000004',
   '7a000000-0000-0000-0000-000000000002', 'auto_revisao', 'pendente'),
  ('7a100000-0000-0000-0000-000000000001', '7a200000-0000-0000-0000-000000000005',
   '7a000000-0000-0000-0000-000000000003', 'arbitragem', 'pendente');

-- (c) Carimbo: cada ciclo nasce com o hash atual do seu campo.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.field_reviews
    WHERE project_id = '7a100000-0000-0000-0000-000000000001'
      AND field_hash IS DISTINCT FROM field_name || '00000000001'
  ) THEN
    RAISE EXCEPTION 'FALHOU: ciclo aberto sem o hash atual do campo';
  END IF;
  BEGIN
    UPDATE public.field_reviews SET field_hash = NULL
    WHERE document_id = '7a200000-0000-0000-0000-000000000001' AND field_name = 'a';
    RAISE EXCEPTION 'FALHOU: field_hash do ciclo aceitou escrita';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'OK: carimbo na abertura e imutavel';
END;
$$;

-- (d) Par "=": a escrita so aceita respostas dadas a versao atual da
-- pergunta. A rodada nao entra: resposta nao vigente e congelada, e o par com
-- ela vale enquanto a pergunta nao muda.
DO $$
DECLARE
  current_field CONSTANT JSONB := '{"name":"q","type":"text","description":"P","hash":"aaaaaaaaaaaa"}';
  item RECORD;
BEGIN
  -- A mesma matriz de `answersCurrentQuestion` em answer-staleness.test.ts.
  FOR item IN
    SELECT * FROM (VALUES
      ('hash igual ao atual', '{"q":"aaaaaaaaaaaa"}'::JSONB, current_field, true),
      ('hash de outra versao da pergunta', '{"q":"ffffffffffff"}'::JSONB, current_field, false),
      ('campo removido ou renomeado', '{"q":"aaaaaaaaaaaa"}'::JSONB, NULL::JSONB, false),
      ('mapa nulo (legado)', NULL::JSONB, current_field, true),
      ('mapa vazio (legado)', '{}'::JSONB, current_field, true),
      ('chave ausente em mapa nao vazio', '{"outro":"bbbbbbbbbbbb"}'::JSONB, current_field, true),
      ('hash nulo do campo', '{"q":null}'::JSONB, current_field, true),
      ('campo atual sem hash e resposta com hash', '{"q":"aaaaaaaaaaaa"}'::JSONB, '{"name":"q"}'::JSONB, false),
      ('campo atual sem hash e resposta sem hash', '{"q":null}'::JSONB, '{"name":"q"}'::JSONB, true)
    ) AS matrix(label, hashes, field, expected)
  LOOP
    IF public.response_answers_current_question(item.hashes, item.field) IS DISTINCT FROM item.expected THEN
      RAISE EXCEPTION 'FALHOU: caso "%" deveria dar %', item.label, item.expected;
    END IF;
  END LOOP;
  RAISE NOTICE 'OK: matriz da resposta na pergunta atual';
END;
$$;

-- Respostas extras do documento 1: uma de rodada anterior (nao vigente) na
-- pergunta atual, uma de outra versao de `a`, e uma sem hash (legado).
INSERT INTO public.responses (id, project_id, document_id, respondent_id, respondent_type, answers, answer_field_hashes, is_latest, is_partial) VALUES
  ('7a300000-0000-0000-0000-000000000031', '7a100000-0000-0000-0000-000000000001',
   '7a200000-0000-0000-0000-000000000001', '7a000000-0000-0000-0000-000000000003', 'humano',
   '{"a":"antiga"}', '{"a":"a00000000001"}', false, false),
  ('7a300000-0000-0000-0000-000000000032', '7a100000-0000-0000-0000-000000000001',
   '7a200000-0000-0000-0000-000000000001', '7a000000-0000-0000-0000-000000000003', 'humano',
   '{"a":"outra versao"}', '{"a":"a0000000000f"}', false, false),
  ('7a300000-0000-0000-0000-000000000033', '7a100000-0000-0000-0000-000000000001',
   '7a200000-0000-0000-0000-000000000001', '7a000000-0000-0000-0000-000000000003', 'humano',
   '{"a":"sem hash"}', '{}', false, false);

CREATE FUNCTION pg_temp.pair_row(p_a TEXT, p_b TEXT) RETURNS JSONB LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'project_id', '7a100000-0000-0000-0000-000000000001', 'document_id', '7a200000-0000-0000-0000-000000000001',
    'field_name', 'a', 'response_a_id', '7a300000-0000-0000-0000-0000000000' || p_a,
    'response_b_id', '7a300000-0000-0000-0000-0000000000' || p_b, 'reviewer_id', '7a000000-0000-0000-0000-000000000001');
$$;

DO $$
DECLARE
  item RECORD;
  v_message TEXT;
BEGIN
  -- Recusa, e nada gravado, com a resposta de outra versao em qualquer lado do
  -- par e no lote de varios pares da Comparacao (confirmEquivalentVerdict).
  FOR item IN
    SELECT * FROM (VALUES
      ('lado b de outra versao', jsonb_build_array(pg_temp.pair_row('01', '32'))),
      ('lado a de outra versao', jsonb_build_array(pg_temp.pair_row('32', '33'))),
      ('lote da Comparacao com um par de outra versao',
       jsonb_build_array(pg_temp.pair_row('01', '11'), pg_temp.pair_row('01', '32'), pg_temp.pair_row('11', '32')))
    ) AS cases(label, payload)
  LOOP
    v_message := NULL;
    BEGIN
      PERFORM public.record_response_equivalences(item.payload);
    EXCEPTION WHEN check_violation THEN
      v_message := SQLERRM;
    END;
    IF v_message IS NULL OR v_message NOT LIKE '%outra versão da pergunta%' THEN
      RAISE EXCEPTION 'FALHOU: par "=" x %: deveria recusar explicando a versao da pergunta (%)', item.label, v_message;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.response_equivalences WHERE document_id = '7a200000-0000-0000-0000-000000000001') THEN
    RAISE EXCEPTION 'FALHOU: a recusa deixou par gravado';
  END IF;

  -- Aceita: resposta de rodada anterior na pergunta atual (o par do LLM
  -- Insights, markLlmEquivalent, com a resposta escolhida de outra rodada) e
  -- resposta sem hash.
  PERFORM public.record_response_equivalences(jsonb_build_array(pg_temp.pair_row('01', '31')));
  PERFORM public.record_response_equivalences(jsonb_build_array(pg_temp.pair_row('01', '33')));
  IF (SELECT count(*) FROM public.response_equivalences WHERE document_id = '7a200000-0000-0000-0000-000000000001') <> 2 THEN
    RAISE EXCEPTION 'FALHOU: par de resposta nao vigente ou sem hash na pergunta atual deveria ser gravado';
  END IF;
  DELETE FROM public.response_equivalences WHERE document_id = '7a200000-0000-0000-0000-000000000001';
  RAISE NOTICE 'OK: par "=" recusa resposta de outra versao da pergunta e aceita a de outra rodada';
END;
$$;

-- Pares vigentes, um por (documento 1..5, campo): humano = LLM.
SELECT public.record_response_equivalences(jsonb_agg(jsonb_build_object(
  'project_id', '7a100000-0000-0000-0000-000000000001', 'document_id', ('7a200000-0000-0000-0000-00000000000' || n),
  'field_name', field_name,
  'response_a_id', ('7a300000-0000-0000-0000-00000000000' || n), 'response_b_id', ('7a300000-0000-0000-0000-00000000001' || n),
  'reviewer_id', '7a000000-0000-0000-0000-000000000001')))
FROM generate_series(1, 5) AS n, unnest(ARRAY['a', 'q', 'e', 'r', 'x']) AS field_name;

DO $$
BEGIN
  IF (SELECT count(*) FROM public.response_equivalences WHERE project_id = '7a100000-0000-0000-0000-000000000001') <> 25 THEN
    RAISE EXCEPTION 'FALHOU: pares vigentes deveriam ter sido gravados';
  END IF;
END;
$$;

-- (e) Os eventos. Resposta editada: o humano do documento 3 muda `e`.
UPDATE public.responses SET answers = answers || '{"e":"humano editado"}'
WHERE id = '7a300000-0000-0000-0000-000000000013';

-- O save do schema: `a` e `e` identicos, `q` com outra descricao (outro
-- hash), `r` renomeado para `r2`, `x` removido.
UPDATE public.projects
SET pydantic_fields = '[{"id":"7af00000-0000-4000-8000-000000000001","name":"a","type":"text","target":"all","description":"Identica","hash":"a00000000001"},
     {"id":"7af00000-0000-4000-8000-000000000002","name":"q","type":"text","target":"all","description":"Alterada de novo","hash":"q00000000002"},
     {"id":"7af00000-0000-4000-8000-000000000003","name":"e","type":"text","target":"all","description":"Editada","hash":"e00000000001"},
     {"id":"7af00000-0000-4000-8000-000000000004","name":"r2","type":"text","target":"all","description":"Renomeada","hash":"r20000000001"}]',
    pydantic_hash = 'schema-v2',
    schema_revision = schema_revision + 1
WHERE id = '7a100000-0000-0000-0000-000000000001';

DO $$
DECLARE
  item RECORD;
BEGIN
  -- Auto-revisao x evento: o que ficou operacional e o motivo do que saiu.
  FOR item IN
    SELECT * FROM (VALUES
      ('a', 'pergunta identica', 5, NULL::TEXT),
      ('q', 'pergunta alterada', 0, 'question_changed'),
      ('e', 'resposta editada', 4, 'answer_changed'),
      ('r', 'campo renomeado', 0, 'field_removed'),
      ('x', 'campo removido', 0, 'field_removed')
    ) AS matrix(field_name, event, operational, reason)
  LOOP
    IF (SELECT count(*) FROM public.field_reviews
        WHERE project_id = '7a100000-0000-0000-0000-000000000001' AND field_name = item.field_name) <> item.operational THEN
      RAISE EXCEPTION 'FALHOU: auto-revisao x %: esperava % ciclo(s) operacional(is)', item.event, item.operational;
    END IF;
    IF item.reason IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.field_review_cycle_history_entries
      WHERE project_id = '7a100000-0000-0000-0000-000000000001' AND field_name = item.field_name
        AND superseded_reason = item.reason
    ) THEN
      RAISE EXCEPTION 'FALHOU: auto-revisao x %: historico sem o motivo %', item.event, item.reason;
    END IF;
  END LOOP;

  -- Os vereditos de `a` sobrevivem intactos ao save do schema.
  IF EXISTS (SELECT 1 FROM public.field_reviews
             WHERE project_id = '7a100000-0000-0000-0000-000000000001' AND field_name = 'a'
               AND self_verdict IS DISTINCT FROM 'admite_erro') THEN
    RAISE EXCEPTION 'FALHOU: pergunta identica perdeu o veredito da auto-revisao';
  END IF;

  -- Par "=" x evento no banco: a pergunta alterada nao arquiva o par (a regra
  -- e de leitura); a resposta editada, sim, pelo gatilho de resposta.
  FOR item IN
    SELECT * FROM (VALUES ('a', 5), ('q', 5), ('e', 4), ('r', 5), ('x', 5)) AS matrix(field_name, operational)
  LOOP
    IF (SELECT count(*) FROM public.response_equivalences
        WHERE project_id = '7a100000-0000-0000-0000-000000000001' AND field_name = item.field_name) <> item.operational THEN
      RAISE EXCEPTION 'FALHOU: par "=" do campo %: esperava % operacional(is)', item.field_name, item.operational;
    END IF;
  END LOOP;

  -- Sem ciclo pendente, a fila do documento fecha no proprio save do schema:
  -- a auto-revisao do documento 4 conclui e a arbitragem do 5 sai.
  IF (SELECT status FROM public.assignments
      WHERE document_id = '7a200000-0000-0000-0000-000000000004' AND type = 'auto_revisao') IS DISTINCT FROM 'concluido' THEN
    RAISE EXCEPTION 'FALHOU: a auto-revisao do documento continuou aberta sem ciclo pendente';
  END IF;
  IF EXISTS (SELECT 1 FROM public.assignments
             WHERE document_id = '7a200000-0000-0000-0000-000000000005' AND type = 'arbitragem') THEN
    RAISE EXCEPTION 'FALHOU: a arbitragem aberta continuou sem ciclo a arbitrar';
  END IF;

  -- So a pergunta alterada (campo que continua existindo) reabre ciclo: os
  -- documentos 1..5 voltam para a fila do reconciliador.
  IF (SELECT count(*) FROM public.auto_review_reconciliation_requests
      WHERE project_id = '7a100000-0000-0000-0000-000000000001') <> 5 THEN
    RAISE EXCEPTION 'FALHOU: pergunta alterada deveria enfileirar a reconciliacao dos documentos';
  END IF;
  RAISE NOTICE 'OK: matriz auto-revisao e par "=" x evento';
END;
$$;

-- A view. O documento 6 nao tem ciclo nem reconciliacao pendente: `r2` nao
-- foi respondido pela geracao LLM (campo renomeado), entao nao e consenso,
-- e `a` e. O documento 1 espera a reconciliacao que o save pediu.
DO $$
DECLARE
  item RECORD;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('7a200000-0000-0000-0000-000000000006'::UUID, 'a', 'consenso'),
      ('7a200000-0000-0000-0000-000000000006'::UUID, 'r2', 'pergunta_alterada'),
      -- Mapa legado vazio nao prova que o LLM deixou o campo de fora.
      ('7a200000-0000-0000-0000-000000000007'::UUID, 'r2', 'consenso'),
      ('7a200000-0000-0000-0000-000000000001'::UUID, 'q', 'aguarda_reconciliacao')
    ) AS matrix(document_id, field_name, provenance)
  LOOP
    IF (SELECT provenance FROM public.final_answers
        WHERE document_id = item.document_id AND field_name = item.field_name)
       IS DISTINCT FROM item.provenance THEN
      RAISE EXCEPTION 'FALHOU: final_answers do campo % deveria ser %', item.field_name, item.provenance;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.final_answers
             WHERE document_id = '7a200000-0000-0000-0000-000000000006' AND field_name = 'r2' AND answer IS NOT NULL) THEN
    RAISE EXCEPTION 'FALHOU: campo renomeado nao pode ter resposta final';
  END IF;
  RAISE NOTICE 'OK: final_answers nao fabrica consenso para campo renomeado';
END;
$$;

-- "Volta a ficar pendente quando cabivel": o reconciliador, com `q` ainda
-- divergente, abre um ciclo novo, pendente e carimbado com a pergunta nova.
SET LOCAL request.jwt.claims = '{"role":"service_role"}';
SELECT public.reconcile_auto_review_cycles(jsonb_build_array(jsonb_build_object(
  'human_response_id', '7a300000-0000-0000-0000-000000000011',
  'llm_response_id', '7a300000-0000-0000-0000-000000000001',
  'field_names', '["a","q","e","r2"]'::JSONB,
  'divergent_field_names', '["a","q","e"]'::JSONB,
  'expected_human_updated_at', (SELECT updated_at FROM public.responses WHERE id = '7a300000-0000-0000-0000-000000000011'),
  'expected_llm_updated_at', (SELECT updated_at FROM public.responses WHERE id = '7a300000-0000-0000-0000-000000000001'),
  'expected_project_pydantic_hash', 'schema-v2',
  'expected_equivalence_ids', (SELECT COALESCE(jsonb_agg(id::TEXT ORDER BY id), '[]') FROM public.response_equivalences
                               WHERE document_id = '7a200000-0000-0000-0000-000000000001' AND field_name IN ('a', 'q', 'e', 'r2')))));
RESET request.jwt.claims;

DO $$
DECLARE
  v_cycle public.field_reviews%ROWTYPE;
BEGIN
  SELECT * INTO v_cycle FROM public.field_reviews
  WHERE document_id = '7a200000-0000-0000-0000-000000000001' AND field_name = 'q';
  IF v_cycle.id IS NULL OR v_cycle.self_verdict IS NOT NULL
     OR v_cycle.field_hash IS DISTINCT FROM 'q00000000002' OR v_cycle.cycle_no <> 2 THEN
    RAISE EXCEPTION 'FALHOU: pergunta alterada nao voltou a ficar pendente sob a pergunta nova (%)', row_to_json(v_cycle);
  END IF;
  IF (SELECT self_verdict FROM public.field_reviews
      WHERE document_id = '7a200000-0000-0000-0000-000000000001' AND field_name = 'a') IS DISTINCT FROM 'admite_erro' THEN
    RAISE EXCEPTION 'FALHOU: reconciliar derrubou o veredito da pergunta identica';
  END IF;
  RAISE NOTICE 'OK: ciclo volta a ficar pendente sob a pergunta nova';
END;
$$;

-- Com a reconciliacao do documento 1 concluida, a view mostra o veredito de
-- `a` e a pendencia nova de `q`. O resto da fila sai para a fixture seguir.
DELETE FROM public.auto_review_reconciliation_requests WHERE project_id = '7a100000-0000-0000-0000-000000000001';

DO $$
BEGIN
  IF (SELECT provenance FROM public.final_answers
      WHERE document_id = '7a200000-0000-0000-0000-000000000001' AND field_name = 'a') IS DISTINCT FROM 'auto_corrigido'
     OR (SELECT provenance FROM public.final_answers
         WHERE document_id = '7a200000-0000-0000-0000-000000000001' AND field_name = 'q') IS DISTINCT FROM 'aguarda_auto_revisao' THEN
    RAISE EXCEPTION 'FALHOU: final_answers depois da reconciliacao';
  END IF;
END;
$$;

-- (f) Defesas: um ciclo carimbado com outra versao que escapou do gatilho (o
-- save abaixo roda sem gatilhos). O documento 2 tem `a` decidido; a pergunta
-- `a` muda "por fora".
SET LOCAL session_replication_role = replica;
UPDATE public.projects
SET pydantic_fields = jsonb_set(pydantic_fields, '{0}', pydantic_fields->0 || '{"description":"Por fora","hash":"a00000000002"}'),
    schema_revision = schema_revision + 1
WHERE id = '7a100000-0000-0000-0000-000000000001';
SET LOCAL session_replication_role = origin;

DO $$
BEGIN
  IF (SELECT provenance FROM public.final_answers
      WHERE document_id = '7a200000-0000-0000-0000-000000000002' AND field_name = 'a') IS DISTINCT FROM 'pergunta_alterada' THEN
    RAISE EXCEPTION 'FALHOU: final_answers contou auto-revisao de outra versao da pergunta';
  END IF;
  RAISE NOTICE 'OK: final_answers nao conta ciclo de outra versao da pergunta';
END;
$$;

-- llm_error_context com fonte de auto-revisao: o ciclo do documento 2 em `a`
-- e contestado, vai a arbitragem e e decidido; como o carimbo e de outra
-- versao, nao e fonte.
UPDATE public.field_reviews
SET self_verdict = 'contesta_llm', self_justification = 'discordo',
    arbitrator_id = '7a000000-0000-0000-0000-000000000003'
WHERE document_id = '7a200000-0000-0000-0000-000000000002' AND field_name = 'a';
UPDATE public.field_reviews
SET blind_verdict = 'humano', blind_decided_at = now(), final_verdict = 'humano', final_decided_at = now()
WHERE document_id = '7a200000-0000-0000-0000-000000000002' AND field_name = 'a';

CREATE TEMP TABLE question_contexts (label TEXT PRIMARY KEY, context JSONB) ON COMMIT DROP;
GRANT ALL ON question_contexts TO authenticated;

SELECT set_config('request.jwt.claims', '{"sub":"7a000000-0000-0000-0000-000000000001","supabase_uid":"7a000000-0000-0000-0000-000000000001"}', true);
SET LOCAL ROLE authenticated;
INSERT INTO question_contexts
SELECT 'auto_revisao_outra_versao', public.llm_error_context(
  '7a100000-0000-0000-0000-000000000001', '7a200000-0000-0000-0000-000000000002', 'a',
  '7a300000-0000-0000-0000-000000000002', '7a300000-0000-0000-0000-000000000012',
  'auto_revisao', (SELECT id FROM public.field_reviews WHERE document_id = '7a200000-0000-0000-0000-000000000002' AND field_name = 'a'));
RESET ROLE;

DO $$
BEGIN
  IF (SELECT context FROM question_contexts WHERE label = 'auto_revisao_outra_versao') IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU: llm_error_context aceitou auto-revisao de outra versao da pergunta como fonte';
  END IF;
  RAISE NOTICE 'OK: llm_error_context recusa auto-revisao de outra versao da pergunta';
END;
$$;

-- O reconciliador encerra o mesmo ciclo como 'question_changed' e o reabre
-- sob a pergunta atual.
SET LOCAL request.jwt.claims = '{"role":"service_role"}';
SELECT public.reconcile_auto_review_cycles(jsonb_build_array(jsonb_build_object(
  'human_response_id', '7a300000-0000-0000-0000-000000000012',
  'llm_response_id', '7a300000-0000-0000-0000-000000000002',
  'field_names', '["a","q","e","r2"]'::JSONB,
  'divergent_field_names', '["a"]'::JSONB,
  'expected_human_updated_at', (SELECT updated_at FROM public.responses WHERE id = '7a300000-0000-0000-0000-000000000012'),
  'expected_llm_updated_at', (SELECT updated_at FROM public.responses WHERE id = '7a300000-0000-0000-0000-000000000002'),
  'expected_project_pydantic_hash', 'schema-v2',
  'expected_equivalence_ids', (SELECT COALESCE(jsonb_agg(id::TEXT ORDER BY id), '[]') FROM public.response_equivalences
                               WHERE document_id = '7a200000-0000-0000-0000-000000000002' AND field_name IN ('a', 'q', 'e', 'r2')))));
RESET request.jwt.claims;

DO $$
DECLARE
  v_cycle public.field_reviews%ROWTYPE;
BEGIN
  SELECT * INTO v_cycle FROM public.field_reviews
  WHERE document_id = '7a200000-0000-0000-0000-000000000002' AND field_name = 'a';
  IF v_cycle.self_verdict IS NOT NULL OR v_cycle.final_verdict IS NOT NULL
     OR v_cycle.field_hash IS DISTINCT FROM 'a00000000002' THEN
    RAISE EXCEPTION 'FALHOU: reconciliador manteve ciclo de outra versao da pergunta (%)', row_to_json(v_cycle);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.field_review_cycle_history_entries
                 WHERE document_id = '7a200000-0000-0000-0000-000000000002' AND field_name = 'a'
                   AND superseded_reason = 'question_changed' AND final_verdict = 'humano') THEN
    RAISE EXCEPTION 'FALHOU: o ciclo decidido nao foi para o historico como question_changed';
  END IF;
  RAISE NOTICE 'OK: reconciliador encerra e reabre o ciclo de outra versao da pergunta';
END;
$$;

-- (g) Decisao do LLM Insights x evento. Documento 6: dois codificadores. Uma
-- review por campo, com o veredito do segundo codificador, e o contexto de
-- cada decisao calculado agora, com a resposta do PRIMEIRO no contexto.
INSERT INTO public.reviews (id, project_id, document_id, field_name, reviewer_id, verdict, chosen_response_id)
SELECT ('7a40000' || n || '-0000-0000-0000-000000000006')::UUID, '7a100000-0000-0000-0000-000000000001',
  '7a200000-0000-0000-0000-000000000006', field_name, '7a000000-0000-0000-0000-000000000001', 'humano',
  '7a300000-0000-0000-0000-000000000016'
FROM unnest(ARRAY['a', 'q', 'e']) WITH ORDINALITY AS fields(field_name, n);

SELECT set_config('request.jwt.claims', '{"sub":"7a000000-0000-0000-0000-000000000001","supabase_uid":"7a000000-0000-0000-0000-000000000001"}', true);
SET LOCAL ROLE authenticated;
INSERT INTO question_contexts
SELECT 'decisao_' || field_name, public.llm_error_context(
  '7a100000-0000-0000-0000-000000000001', '7a200000-0000-0000-0000-000000000006', field_name,
  '7a300000-0000-0000-0000-000000000006', '7a300000-0000-0000-0000-000000000016',
  'comparacao', ('7a40000' || n || '-0000-0000-0000-000000000006')::UUID)
FROM unnest(ARRAY['a', 'q', 'e']) WITH ORDINALITY AS fields(field_name, n);
RESET ROLE;

INSERT INTO public.error_resolutions (project_id, document_id, field_name, decision, context, resolved_by)
SELECT '7a100000-0000-0000-0000-000000000001', '7a200000-0000-0000-0000-000000000006', substr(label, 9), 'llm_correct', context,
  '7a000000-0000-0000-0000-000000000001'
FROM question_contexts WHERE label LIKE 'decisao_%';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM question_contexts WHERE label LIKE 'decisao_%' AND context IS NULL) THEN
    RAISE EXCEPTION 'FALHOU: fixture de decisao sem contexto';
  END IF;
END;
$$;

-- Eventos: o SEGUNDO codificador (fora do contexto) edita `e`; a pergunta `q`
-- muda; `a` fica identica.
UPDATE public.responses SET answers = answers || '{"e":"outro editado"}'
WHERE id = '7a300000-0000-0000-0000-000000000026';
UPDATE public.projects
SET pydantic_fields = jsonb_set(pydantic_fields, '{1}', pydantic_fields->1 || '{"description":"Terceira versao","hash":"q00000000003"}'),
    schema_revision = schema_revision + 1
WHERE id = '7a100000-0000-0000-0000-000000000001';

SET LOCAL ROLE authenticated;
DO $$
DECLARE
  item RECORD;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('a', 'pergunta identica', true),
      ('q', 'pergunta alterada', false),
      ('e', 'resposta de outro codificador editada', false)
    ) AS matrix(field_name, event, still_current)
  LOOP
    IF (SELECT resolution.current_context IS NOT DISTINCT FROM resolution.context
        FROM public.read_error_resolutions('7a100000-0000-0000-0000-000000000001') AS resolution
        WHERE resolution.document_id = '7a200000-0000-0000-0000-000000000006'
          AND resolution.field_name = item.field_name) IS DISTINCT FROM item.still_current THEN
      RAISE EXCEPTION 'FALHOU: decisao x %: deveria continuar valendo = %', item.event, item.still_current;
    END IF;
  END LOOP;
  RAISE NOTICE 'OK: matriz decisao do LLM Insights x evento';
END;
$$;
RESET ROLE;

-- Backfill: as decisoes do documento 6 voltam ao formato anterior a
-- migration (sem `cell_answers_hash`) e passam pelo backfill que a migration
-- roda, `backfill_error_resolution_cell_answers_hash`. Sem a chave a decisao
-- viva cai; depois dele volta a valer.
UPDATE public.error_resolutions
SET context = context #- '{source,cell_answers_hash}'
WHERE document_id = '7a200000-0000-0000-0000-000000000006';

SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.read_error_resolutions('7a100000-0000-0000-0000-000000000001') AS resolution
    WHERE resolution.document_id = '7a200000-0000-0000-0000-000000000006' AND resolution.field_name = 'a'
      AND resolution.current_context = resolution.context
  ) THEN
    RAISE EXCEPTION 'FALHOU: fixture do backfill: sem a chave a decisao deveria estar caida';
  END IF;
END;
$$;
RESET ROLE;

DO $$
BEGIN
  IF public.backfill_error_resolution_cell_answers_hash() <> 3 THEN
    RAISE EXCEPTION 'FALHOU: o backfill deveria gravar o hash da celula nas 3 decisoes sem ele';
  END IF;
  IF public.backfill_error_resolution_cell_answers_hash() <> 0 THEN
    RAISE EXCEPTION 'FALHOU: o backfill deveria ser idempotente';
  END IF;
END;
$$;

SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.read_error_resolutions('7a100000-0000-0000-0000-000000000001') AS resolution
    WHERE resolution.document_id = '7a200000-0000-0000-0000-000000000006' AND resolution.field_name = 'a'
      AND resolution.current_context = resolution.context
  ) THEN
    RAISE EXCEPTION 'FALHOU: o backfill do hash da celula nao revalidou a decisao viva';
  END IF;
  RAISE NOTICE 'OK: backfill do hash da celula preserva decisao viva';
END;
$$;
RESET ROLE;

ROLLBACK;
