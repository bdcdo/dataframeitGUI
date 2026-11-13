-- Contrato da equivalencia "=" por VALOR (`value_equivalences`,
-- 20261112120000): "no campo X, na versao da pergunta com hash H, o valor A
-- equivale ao valor B", no projeto inteiro.
--
-- Blocos:
--   (a) catalogo: RLS ligada, so policy de leitura, indice unico, grants;
--   (b) record_value_equivalences: valor e hash saem do banco, par canonico,
--       idempotente por valor (o mesmo par em outro documento nao duplica),
--       valores identicos nao gravam;
--   (c) recusas: revisor de outra identidade, origem reservada, resposta de
--       outro documento, quem nao e do projeto;
--   (d) escrita direta pela API recusada, leitura isolada por projeto;
--   (e) a equivalencia sobrevive a execucao nova do LLM e a recodificacao
--       (o defeito que motivou a tabela: o par de resposta caia);
--   (f) remove_value_equivalence: autoridade (dono, coordenacao), historico
--       'manually_removed' e NENHUM veredito apagado;
--   (g) veredito 'equivalente' da auto-revisao grava a equivalencia de valor
--       com o carimbo do ciclo;
--   (h) enqueue_auto_review_reconciliation_for_documents: so os documentos
--       pedidos, so membro;
--   (i) backfill dos pares de resposta: agrupa por valor, pula outra versao
--       da pergunta e valores identicos, idempotente;
--   (j) apagar o projeto nao falha no arquivamento (guarda do cascade).
--
-- Quem age como usuario troca tambem a autorizacao da sessao para
-- `authenticator`: as RPCs liberam `SESSION_USER = 'postgres'` (migrations e
-- scripts), e com a sessao de superusuario nenhuma recusa seria exercitada.
--
-- Roda numa transacao e nao deixa fixture no banco local.

BEGIN;

-- (a) Catalogo.
DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.value_equivalences'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.value_equivalence_history_entries'::regclass) THEN
    RAISE EXCEPTION 'FALHOU: RLS deveria estar ligada nas duas tabelas';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('value_equivalences', 'value_equivalence_history_entries')
      AND cmd <> 'SELECT'
  ) THEN
    RAISE EXCEPTION 'FALHOU: escrita so por RPC, sem policy de escrita';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_policies
      WHERE schemaname = 'public'
        AND tablename IN ('value_equivalences', 'value_equivalence_history_entries')) <> 2 THEN
    RAISE EXCEPTION 'FALHOU: cada tabela deveria ter a policy de leitura';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_indexes
    WHERE schemaname = 'public' AND indexname = 'value_equivalences_unique_pair'
      AND indexdef LIKE 'CREATE UNIQUE INDEX%'
  ) THEN
    RAISE EXCEPTION 'FALHOU: indice unico do par de valor ausente';
  END IF;
  IF has_function_privilege('anon', 'public.record_value_equivalences(jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.remove_value_equivalence(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.backfill_value_equivalences_from_response_pairs()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.record_value_equivalences(jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.remove_value_equivalence(uuid, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.enqueue_auto_review_reconciliation_for_documents(uuid, uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'FALHOU: grants das RPCs';
  END IF;
  RAISE NOTICE 'OK: catalogo';
END;
$$;

-- Fixture. Projeto 1 em auto-revisao com os campos `f` e `g`; projeto 2 para
-- o isolamento. Usuarios: criadora (e1), coordenadora (e2), pesquisadora dona
-- das equivalencias (e3), outra pesquisadora (e4), quem nao e do projeto (e5).
INSERT INTO auth.users (id, email) VALUES
  ('5e000000-0000-0000-0000-000000000001', 'valor-criadora@example.test'),
  ('5e000000-0000-0000-0000-000000000002', 'valor-coord@example.test'),
  ('5e000000-0000-0000-0000-000000000003', 'valor-dona@example.test'),
  ('5e000000-0000-0000-0000-000000000004', 'valor-outra@example.test'),
  ('5e000000-0000-0000-0000-000000000005', 'valor-fora@example.test');
INSERT INTO public.clerk_user_mapping (clerk_user_id, supabase_user_id, access_sync_version)
  SELECT id::TEXT, id, 1 FROM auth.users WHERE id::TEXT LIKE '5e000000-%';

INSERT INTO public.projects (id, name, created_by, automation_mode, pydantic_hash, pydantic_fields) VALUES
  ('5e100000-0000-0000-0000-000000000001', 'equivalencia por valor',
   '5e000000-0000-0000-0000-000000000001', 'auto_review_llm', 'schema-v1',
   '[{"id":"5ef00000-0000-4000-8000-000000000001","name":"f","type":"text","target":"all","description":"Data","hash":"f00000000001"},
     {"id":"5ef00000-0000-4000-8000-000000000002","name":"g","type":"text","target":"all","description":"Outra","hash":"g00000000001"}]'),
  ('5e100000-0000-0000-0000-000000000002', 'outro projeto',
   '5e000000-0000-0000-0000-000000000005', 'none', 'schema-v1',
   '[{"id":"5ef00000-0000-4000-8000-000000000003","name":"f","type":"text","target":"all","description":"Data","hash":"f00000000001"}]');

INSERT INTO public.project_members (project_id, user_id, role) VALUES
  ('5e100000-0000-0000-0000-000000000001', '5e000000-0000-0000-0000-000000000002', 'coordenador'),
  ('5e100000-0000-0000-0000-000000000001', '5e000000-0000-0000-0000-000000000003', 'pesquisador'),
  ('5e100000-0000-0000-0000-000000000001', '5e000000-0000-0000-0000-000000000004', 'pesquisador'),
  ('5e100000-0000-0000-0000-000000000002', '5e000000-0000-0000-0000-000000000005', 'pesquisador');

INSERT INTO public.documents (id, project_id, title, text) VALUES
  ('5e200000-0000-0000-0000-000000000001', '5e100000-0000-0000-0000-000000000001', 'Doc 1', 'Texto'),
  ('5e200000-0000-0000-0000-000000000002', '5e100000-0000-0000-0000-000000000001', 'Doc 2', 'Texto'),
  ('5e200000-0000-0000-0000-000000000009', '5e100000-0000-0000-0000-000000000002', 'Doc 9', 'Texto');

-- LLM …0n, humano …1n. Nos dois documentos o LLM diz "Não informado" e o
-- humano "nao identificavel" em `f`; em `g` os dois dizem o mesmo.
INSERT INTO public.responses (id, project_id, document_id, respondent_id, respondent_type, answers, answer_field_hashes, is_partial) VALUES
  ('5e300000-0000-0000-0000-000000000001', '5e100000-0000-0000-0000-000000000001', '5e200000-0000-0000-0000-000000000001',
   NULL, 'llm', '{"f":"Não informado","g":"x"}', '{"f":"f00000000001","g":"g00000000001"}', false),
  ('5e300000-0000-0000-0000-000000000011', '5e100000-0000-0000-0000-000000000001', '5e200000-0000-0000-0000-000000000001',
   '5e000000-0000-0000-0000-000000000003', 'humano', '{"f":"nao identificavel","g":"x"}', '{"f":"f00000000001","g":"g00000000001"}', false),
  ('5e300000-0000-0000-0000-000000000002', '5e100000-0000-0000-0000-000000000001', '5e200000-0000-0000-0000-000000000002',
   NULL, 'llm', '{"f":"Não informado","g":"x"}', '{"f":"f00000000001","g":"g00000000001"}', false),
  ('5e300000-0000-0000-0000-000000000012', '5e100000-0000-0000-0000-000000000001', '5e200000-0000-0000-0000-000000000002',
   '5e000000-0000-0000-0000-000000000004', 'humano', '{"f":"nao identificavel","g":"x"}', '{"f":"f00000000001","g":"g00000000001"}', false),
  -- Resposta do documento 1 dada a outra versao de `f`.
  ('5e300000-0000-0000-0000-000000000021', '5e100000-0000-0000-0000-000000000001', '5e200000-0000-0000-0000-000000000001',
   '5e000000-0000-0000-0000-000000000004', 'humano', '{"f":"outra versao"}', '{"f":"f0000000000f"}', false),
  ('5e300000-0000-0000-0000-000000000009', '5e100000-0000-0000-0000-000000000002', '5e200000-0000-0000-0000-000000000009',
   NULL, 'llm', '{"f":"a"}', '{"f":"f00000000001"}', false),
  ('5e300000-0000-0000-0000-000000000019', '5e100000-0000-0000-0000-000000000002', '5e200000-0000-0000-0000-000000000009',
   '5e000000-0000-0000-0000-000000000005', 'humano', '{"f":"b"}', '{"f":"f00000000001"}', false);

DELETE FROM public.auto_review_reconciliation_requests
WHERE project_id IN ('5e100000-0000-0000-0000-000000000001', '5e100000-0000-0000-0000-000000000002');

CREATE FUNCTION pg_temp.pair(p_doc TEXT, p_a TEXT, p_b TEXT, p_reviewer TEXT, p_field TEXT DEFAULT 'f', p_source TEXT DEFAULT 'comparacao')
RETURNS JSONB LANGUAGE sql AS $$
  SELECT jsonb_build_array(jsonb_build_object(
    'project_id', '5e100000-0000-0000-0000-000000000001',
    'document_id', '5e200000-0000-0000-0000-00000000000' || p_doc,
    'field_name', p_field,
    'response_a_id', '5e300000-0000-0000-0000-0000000000' || p_a,
    'response_b_id', '5e300000-0000-0000-0000-0000000000' || p_b,
    'reviewer_id', '5e000000-0000-0000-0000-00000000000' || p_reviewer,
    'source', p_source));
$$;

-- (b) Gravar, como a pesquisadora dona (e3).
SELECT set_config('request.jwt.claims',
  '{"sub":"5e000000-0000-0000-0000-000000000003","supabase_uid":"5e000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_row RECORD;
BEGIN
  IF public.record_value_equivalences(pg_temp.pair('1', '01', '11', '3')) <> 1 THEN
    RAISE EXCEPTION 'FALHOU: a equivalencia deveria ser gravada';
  END IF;
  SELECT * INTO v_row FROM public.value_equivalences
  WHERE project_id = '5e100000-0000-0000-0000-000000000001';
  IF v_row.value_a <> '"Não informado"'::JSONB OR v_row.value_b <> '"nao identificavel"'::JSONB
     OR v_row.field_hash <> 'f00000000001' OR v_row.source <> 'comparacao'
     OR v_row.origin_document_id <> '5e200000-0000-0000-0000-000000000001'
     OR v_row.reviewer_id <> '5e000000-0000-0000-0000-000000000003' THEN
    RAISE EXCEPTION 'FALHOU: valores, hash ou origem gravados errados: %', row_to_json(v_row);
  END IF;
  -- O mesmo par de valores marcado em outro documento, e na ordem inversa:
  -- a equivalencia ja existe no projeto.
  IF public.record_value_equivalences(pg_temp.pair('2', '12', '02', '3')) <> 0 THEN
    RAISE EXCEPTION 'FALHOU: o mesmo par de valores nao deveria duplicar';
  END IF;
  -- Valores identicos nao tem o que fundir.
  IF public.record_value_equivalences(pg_temp.pair('1', '01', '11', '3', 'g')) <> 0 THEN
    RAISE EXCEPTION 'FALHOU: valores identicos nao deveriam gravar';
  END IF;
  IF (SELECT count(*) FROM public.value_equivalences
      WHERE project_id = '5e100000-0000-0000-0000-000000000001') <> 1 THEN
    RAISE EXCEPTION 'FALHOU: deveria haver uma equivalencia no projeto';
  END IF;
  RAISE NOTICE 'OK: grava por valor, canonica e idempotente';
END;
$$;

-- (c) Recusas.
DO $$
DECLARE
  item RECORD;
  v_failed BOOLEAN;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('revisor de outra identidade', pg_temp.pair('1', '01', '11', '4')),
      ('origem reservada', pg_temp.pair('1', '01', '11', '3', 'f', 'migracao')),
      ('resposta de outro documento', pg_temp.pair('1', '01', '12', '3')),
      ('resposta de outra versao da pergunta', pg_temp.pair('1', '01', '21', '3'))
    ) AS cases(label, payload)
  LOOP
    v_failed := false;
    BEGIN
      PERFORM public.record_value_equivalences(item.payload);
    EXCEPTION WHEN OTHERS THEN
      v_failed := true;
    END;
    IF NOT v_failed THEN
      RAISE EXCEPTION 'FALHOU: % deveria ser recusado', item.label;
    END IF;
  END LOOP;
  RAISE NOTICE 'OK: recusas da gravacao';
END;
$$;
RESET ROLE;
RESET SESSION AUTHORIZATION;

SELECT set_config('request.jwt.claims',
  '{"sub":"5e000000-0000-0000-0000-000000000005","supabase_uid":"5e000000-0000-0000-0000-000000000005","role":"authenticated"}', true);
SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_failed BOOLEAN := false;
BEGIN
  BEGIN
    PERFORM public.record_value_equivalences(pg_temp.pair('1', '01', '11', '5'));
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'FALHOU: quem nao e do projeto gravou equivalencia';
  END IF;
  -- (d) Leitura isolada: quem nao e do projeto 1 nao ve a equivalencia dele.
  IF EXISTS (SELECT 1 FROM public.value_equivalences
             WHERE project_id = '5e100000-0000-0000-0000-000000000001') THEN
    RAISE EXCEPTION 'FALHOU: equivalencia de outro projeto visivel';
  END IF;
  v_failed := false;
  BEGIN
    PERFORM public.enqueue_auto_review_reconciliation_for_documents(
      '5e100000-0000-0000-0000-000000000001', ARRAY['5e200000-0000-0000-0000-000000000001'::UUID]);
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'FALHOU: quem nao e do projeto enfileirou reconciliacao';
  END IF;
  RAISE NOTICE 'OK: isolamento entre projetos';
END;
$$;
RESET ROLE;
RESET SESSION AUTHORIZATION;

-- (d) Escrita direta pela API, mesmo pela coordenadora: nenhuma policy de
-- escrita, entao INSERT falha e UPDATE/DELETE nao alcancam linha.
SELECT set_config('request.jwt.claims',
  '{"sub":"5e000000-0000-0000-0000-000000000002","supabase_uid":"5e000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_failed BOOLEAN := false;
  v_count INTEGER;
BEGIN
  IF (SELECT count(*) FROM public.value_equivalences
      WHERE project_id = '5e100000-0000-0000-0000-000000000001') <> 1 THEN
    RAISE EXCEPTION 'FALHOU: a coordenadora deveria ver a equivalencia do projeto';
  END IF;
  BEGIN
    INSERT INTO public.value_equivalences (project_id, field_name, field_hash, value_a, value_b, source)
    VALUES ('5e100000-0000-0000-0000-000000000001', 'f', 'f00000000001', '"a"', '"b"', 'comparacao');
  EXCEPTION WHEN insufficient_privilege THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'FALHOU: INSERT direto deveria ser recusado';
  END IF;
  UPDATE public.value_equivalences SET value_b = '"zzz"'
  WHERE project_id = '5e100000-0000-0000-0000-000000000001';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FALHOU: UPDATE direto alcancou linha';
  END IF;
  DELETE FROM public.value_equivalences WHERE project_id = '5e100000-0000-0000-0000-000000000001';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FALHOU: DELETE direto alcancou linha';
  END IF;
  RAISE NOTICE 'OK: escrita so por RPC';
END;
$$;
RESET ROLE;
RESET SESSION AUTHORIZATION;

-- (e) Execucao nova do LLM no documento 1, com o mesmo valor em `f`, e o
-- humano do documento 2 salvo de novo com o mesmo valor: a equivalencia fica.
UPDATE public.responses SET is_latest = false WHERE id = '5e300000-0000-0000-0000-000000000001';
INSERT INTO public.responses (id, project_id, document_id, respondent_id, respondent_type, answers, answer_field_hashes, is_partial) VALUES
  ('5e300000-0000-0000-0000-000000000031', '5e100000-0000-0000-0000-000000000001', '5e200000-0000-0000-0000-000000000001',
   NULL, 'llm', '{"f":"Não informado","g":"y"}', '{"f":"f00000000001","g":"g00000000001"}', false);
UPDATE public.responses SET answers = answers || '{"g":"z"}' WHERE id = '5e300000-0000-0000-0000-000000000012';

DO $$
BEGIN
  IF (SELECT count(*) FROM public.value_equivalences
      WHERE project_id = '5e100000-0000-0000-0000-000000000001') <> 1 THEN
    RAISE EXCEPTION 'FALHOU: a equivalencia de valor caiu com a execucao nova do LLM ou a recodificacao';
  END IF;
  RAISE NOTICE 'OK: sobrevive a execucao nova do LLM e a recodificacao';
END;
$$;

-- Um veredito da dona no documento 1, para provar que desfazer nao o apaga.
INSERT INTO public.reviews (project_id, document_id, field_name, reviewer_id, verdict, chosen_response_id)
VALUES ('5e100000-0000-0000-0000-000000000001', '5e200000-0000-0000-0000-000000000001', 'f',
        '5e000000-0000-0000-0000-000000000003', 'nao identificavel', '5e300000-0000-0000-0000-000000000011');

-- (f) Desfazer: a outra pesquisadora (e4) nao e dona nem coordena.
SELECT set_config('request.jwt.claims',
  '{"sub":"5e000000-0000-0000-0000-000000000004","supabase_uid":"5e000000-0000-0000-0000-000000000004","role":"authenticated"}', true);
SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_id UUID;
BEGIN
  SELECT id INTO v_id FROM public.value_equivalences WHERE project_id = '5e100000-0000-0000-0000-000000000001';
  IF EXISTS (SELECT 1 FROM public.remove_value_equivalence('5e100000-0000-0000-0000-000000000001', v_id)) THEN
    RAISE EXCEPTION 'FALHOU: pesquisadora que nao e dona desfez a equivalencia';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.value_equivalences WHERE id = v_id) THEN
    RAISE EXCEPTION 'FALHOU: a recusa removeu a equivalencia';
  END IF;
  RAISE NOTICE 'OK: so dono ou coordenacao desfaz';
END;
$$;
RESET ROLE;
RESET SESSION AUTHORIZATION;

SELECT set_config('request.jwt.claims',
  '{"sub":"5e000000-0000-0000-0000-000000000003","supabase_uid":"5e000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_id UUID;
  v_field TEXT;
BEGIN
  SELECT id INTO v_id FROM public.value_equivalences WHERE project_id = '5e100000-0000-0000-0000-000000000001';
  SELECT field_name INTO v_field FROM public.remove_value_equivalence('5e100000-0000-0000-0000-000000000001', v_id);
  IF v_field IS DISTINCT FROM 'f' THEN
    RAISE EXCEPTION 'FALHOU: a dona deveria desfazer e receber o campo';
  END IF;
  IF EXISTS (SELECT 1 FROM public.value_equivalences WHERE id = v_id) THEN
    RAISE EXCEPTION 'FALHOU: a equivalencia continuou operacional';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.value_equivalence_history_entries
                 WHERE id = v_id AND superseded_reason = 'manually_removed') THEN
    RAISE EXCEPTION 'FALHOU: a equivalencia desfeita deveria ir ao historico';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.reviews
                 WHERE document_id = '5e200000-0000-0000-0000-000000000001' AND field_name = 'f'
                   AND reviewer_id = '5e000000-0000-0000-0000-000000000003') THEN
    RAISE EXCEPTION 'FALHOU: desfazer a equivalencia apagou o veredito da dona';
  END IF;
  -- Gravada de novo, para a coordenadora desfazer.
  PERFORM public.record_value_equivalences(pg_temp.pair('1', '31', '11', '3'));
  RAISE NOTICE 'OK: desfazer vai ao historico e nao apaga veredito';
END;
$$;
RESET ROLE;
RESET SESSION AUTHORIZATION;

SELECT set_config('request.jwt.claims',
  '{"sub":"5e000000-0000-0000-0000-000000000002","supabase_uid":"5e000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_id UUID;
BEGIN
  SELECT id INTO v_id FROM public.value_equivalences WHERE project_id = '5e100000-0000-0000-0000-000000000001';
  IF NOT EXISTS (SELECT 1 FROM public.remove_value_equivalence('5e100000-0000-0000-0000-000000000001', v_id)) THEN
    RAISE EXCEPTION 'FALHOU: a coordenadora deveria desfazer a equivalencia de outra pessoa';
  END IF;
  RAISE NOTICE 'OK: coordenacao desfaz';
END;
$$;
RESET ROLE;
RESET SESSION AUTHORIZATION;

-- (g) Auto-revisao do documento 2: o veredito 'equivalente' grava a
-- equivalencia de valor com o carimbo do ciclo. A action chama a RPC pelo
-- service role.
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
INSERT INTO public.field_reviews (id, project_id, document_id, field_name, human_response_id, llm_response_id, self_reviewer_id)
VALUES ('5e400000-0000-0000-0000-000000000001', '5e100000-0000-0000-0000-000000000001', '5e200000-0000-0000-0000-000000000002', 'f',
        '5e300000-0000-0000-0000-000000000012', '5e300000-0000-0000-0000-000000000002', '5e000000-0000-0000-0000-000000000004');

SELECT public.submit_auto_review_verdicts(
  '5e100000-0000-0000-0000-000000000001',
  '5e200000-0000-0000-0000-000000000002',
  '5e000000-0000-0000-0000-000000000004',
  '[{"field_review_id":"5e400000-0000-0000-0000-000000000001","field_name":"f","verdict":"equivalente"}]'::JSONB
);

DO $$
DECLARE
  v_row public.value_equivalences%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.value_equivalences WHERE project_id = '5e100000-0000-0000-0000-000000000001';
  IF v_row.id IS NULL OR v_row.source <> 'auto_revisao' OR v_row.field_hash <> 'f00000000001'
     OR v_row.value_a <> '"Não informado"'::JSONB OR v_row.value_b <> '"nao identificavel"'::JSONB
     OR v_row.reviewer_id <> '5e000000-0000-0000-0000-000000000004'
     OR v_row.origin_document_id <> '5e200000-0000-0000-0000-000000000002' THEN
    RAISE EXCEPTION 'FALHOU: veredito equivalente deveria gravar a equivalencia de valor: %', row_to_json(v_row);
  END IF;
  RAISE NOTICE 'OK: veredito equivalente da auto-revisao vira equivalencia de valor';
END;
$$;

-- (h) Reconciliacao so dos documentos pedidos, por membro.
DELETE FROM public.auto_review_reconciliation_requests WHERE project_id = '5e100000-0000-0000-0000-000000000001';
SELECT set_config('request.jwt.claims',
  '{"sub":"5e000000-0000-0000-0000-000000000004","supabase_uid":"5e000000-0000-0000-0000-000000000004","role":"authenticated"}', true);
SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE authenticated;
SELECT public.enqueue_auto_review_reconciliation_for_documents(
  '5e100000-0000-0000-0000-000000000001', ARRAY['5e200000-0000-0000-0000-000000000002'::UUID]);
RESET ROLE;
RESET SESSION AUTHORIZATION;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.auto_review_reconciliation_requests
                 WHERE document_id = '5e200000-0000-0000-0000-000000000002'
                   AND llm_response_id = '5e300000-0000-0000-0000-000000000002')
     OR EXISTS (SELECT 1 FROM public.auto_review_reconciliation_requests
                WHERE document_id = '5e200000-0000-0000-0000-000000000001') THEN
    RAISE EXCEPTION 'FALHOU: deveria enfileirar so o documento pedido, com a geracao corrente';
  END IF;
  RAISE NOTICE 'OK: enfileira so os documentos pedidos';
END;
$$;

-- (h2) Reconciliador: confere só as equivalências que o worker usou para o
-- documento. Uma equivalência nova em outro valor não derruba a
-- reconciliação em curso; a usada, desfeita no meio, derruba.
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
CREATE FUNCTION pg_temp.reconcile_doc2(p_expected JSONB) RETURNS JSONB LANGUAGE sql AS $$
  SELECT public.reconcile_auto_review_cycles(jsonb_build_array(jsonb_build_object(
    'human_response_id', '5e300000-0000-0000-0000-000000000012',
    'llm_response_id', '5e300000-0000-0000-0000-000000000002',
    'field_names', '["f","g"]'::JSONB,
    'divergent_field_names', '[]'::JSONB,
    'expected_human_updated_at', (SELECT updated_at FROM public.responses WHERE id = '5e300000-0000-0000-0000-000000000012'),
    'expected_llm_updated_at', (SELECT updated_at FROM public.responses WHERE id = '5e300000-0000-0000-0000-000000000002'),
    'expected_project_pydantic_hash', 'schema-v1',
    'expected_equivalence_ids', p_expected)));
$$;
DO $$
DECLARE
  v_used JSONB;
  v_failed BOOLEAN := false;
BEGIN
  SELECT jsonb_agg(id::TEXT) INTO v_used FROM public.value_equivalences
  WHERE project_id = '5e100000-0000-0000-0000-000000000001';
  -- Outra equivalência do mesmo campo, em valores que o documento não tem.
  INSERT INTO public.value_equivalences (project_id, field_name, field_hash, value_a, value_b, source)
  VALUES ('5e100000-0000-0000-0000-000000000001', 'f', 'f00000000001', '"p"', '"q"', 'comparacao');
  PERFORM pg_temp.reconcile_doc2(v_used);

  DELETE FROM public.value_equivalences WHERE id::TEXT = v_used->>0;
  BEGIN
    PERFORM pg_temp.reconcile_doc2(v_used);
  EXCEPTION WHEN OTHERS THEN
    v_failed := SQLERRM LIKE '%inputs changed%';
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'FALHOU: equivalência usada e desfeita no meio deveria recusar a reconciliação';
  END IF;
  RAISE NOTICE 'OK: reconciliador confere só as equivalências do documento';
END;
$$;

-- (i) Backfill dos pares de resposta. Dois pares no projeto com os mesmos
-- valores (viram uma equivalencia, a do par mais antigo), um com resposta de
-- outra versao da pergunta (fica de fora), um com valores identicos (fica de
-- fora), um do projeto 2.
DELETE FROM public.value_equivalences;
INSERT INTO public.response_equivalences (project_id, document_id, field_name, response_a_id, response_b_id, reviewer_id, created_at) VALUES
  ('5e100000-0000-0000-0000-000000000001', '5e200000-0000-0000-0000-000000000002', 'f',
   '5e300000-0000-0000-0000-000000000002', '5e300000-0000-0000-0000-000000000012', '5e000000-0000-0000-0000-000000000004', now()),
  ('5e100000-0000-0000-0000-000000000001', '5e200000-0000-0000-0000-000000000001', 'f',
   '5e300000-0000-0000-0000-000000000011', '5e300000-0000-0000-0000-000000000031', '5e000000-0000-0000-0000-000000000003', now() - interval '1 day'),
  ('5e100000-0000-0000-0000-000000000001', '5e200000-0000-0000-0000-000000000001', 'f',
   '5e300000-0000-0000-0000-000000000011', '5e300000-0000-0000-0000-000000000021', '5e000000-0000-0000-0000-000000000003', now()),
  ('5e100000-0000-0000-0000-000000000001', '5e200000-0000-0000-0000-000000000002', 'g',
   '5e300000-0000-0000-0000-000000000002', '5e300000-0000-0000-0000-000000000012', '5e000000-0000-0000-0000-000000000004', now()),
  ('5e100000-0000-0000-0000-000000000002', '5e200000-0000-0000-0000-000000000009', 'f',
   '5e300000-0000-0000-0000-000000000009', '5e300000-0000-0000-0000-000000000019', '5e000000-0000-0000-0000-000000000005', now());
-- O par de `g` do documento 2 so tem valores identicos se o humano disser o
-- mesmo que o LLM: o humano disse "z" em (e), entao o snapshot e ajustado aqui.
UPDATE public.response_equivalences
SET response_b_answer_snapshot = response_a_answer_snapshot
WHERE document_id = '5e200000-0000-0000-0000-000000000002' AND field_name = 'g';

DO $$
DECLARE
  v_row public.value_equivalences%ROWTYPE;
BEGIN
  IF public.backfill_value_equivalences_from_response_pairs() <> 2 THEN
    RAISE EXCEPTION 'FALHOU: backfill deveria gravar 2 equivalencias (uma por projeto)';
  END IF;
  SELECT * INTO v_row FROM public.value_equivalences WHERE project_id = '5e100000-0000-0000-0000-000000000001';
  IF v_row.source <> 'migracao' OR v_row.field_hash <> 'f00000000001'
     OR v_row.reviewer_id <> '5e000000-0000-0000-0000-000000000003'
     OR v_row.origin_document_id <> '5e200000-0000-0000-0000-000000000001' THEN
    RAISE EXCEPTION 'FALHOU: backfill deveria ficar com o par mais antigo: %', row_to_json(v_row);
  END IF;
  IF EXISTS (SELECT 1 FROM public.response_equivalences WHERE superseded_at IS NULL) THEN
    RAISE EXCEPTION 'FALHOU: o backfill deveria tirar de cena todo par avaliado';
  END IF;
  -- A equivalência migrada e desfeita depois do deploy não volta na nova
  -- chamada (a da migration que remove a tabela antiga).
  DELETE FROM public.value_equivalences WHERE project_id = '5e100000-0000-0000-0000-000000000001';
  IF public.backfill_value_equivalences_from_response_pairs() <> 0
     OR EXISTS (SELECT 1 FROM public.value_equivalences WHERE project_id = '5e100000-0000-0000-0000-000000000001') THEN
    RAISE EXCEPTION 'FALHOU: a nova chamada do backfill ressuscitou a equivalência desfeita';
  END IF;
  RAISE NOTICE 'OK: backfill por valor, sem ressuscitar o que foi desfeito';
END;
$$;

-- (i2) Campo que volta ao schema: só os documentos com resposta igual a um
-- valor de equivalência do histórico daquele nome, e não o projeto inteiro.
INSERT INTO public.value_equivalences (project_id, field_name, field_hash, value_a, value_b, source)
VALUES ('5e100000-0000-0000-0000-000000000001', 'g', 'g00000000001', '"w"', '"x"', 'comparacao');
UPDATE public.projects
SET pydantic_fields = '[{"id":"5ef00000-0000-4000-8000-000000000001","name":"f","type":"text","target":"all","description":"Data","hash":"f00000000001"}]',
    schema_revision = schema_revision + 1
WHERE id = '5e100000-0000-0000-0000-000000000001';
DELETE FROM public.auto_review_reconciliation_requests WHERE project_id = '5e100000-0000-0000-0000-000000000001';
UPDATE public.responses SET answers = answers || '{"g":"outro"}' WHERE id = '5e300000-0000-0000-0000-000000000012';
UPDATE public.responses SET answers = answers || '{"g":"outro"}' WHERE id = '5e300000-0000-0000-0000-000000000002';
DELETE FROM public.auto_review_reconciliation_requests WHERE project_id = '5e100000-0000-0000-0000-000000000001';
UPDATE public.projects
SET pydantic_fields = pydantic_fields || '[{"id":"5ef00000-0000-4000-8000-000000000002","name":"g","type":"text","target":"all","description":"Outra, readicionada","hash":"g00000000002"}]',
    schema_revision = schema_revision + 1
WHERE id = '5e100000-0000-0000-0000-000000000001';
DO $$
BEGIN
  -- Documento 1: o humano diz "x" em `g`, um dos valores da equivalência.
  -- Documento 2: os dois dizem "outro", fora dela.
  IF NOT EXISTS (SELECT 1 FROM public.auto_review_reconciliation_requests
                 WHERE document_id = '5e200000-0000-0000-0000-000000000001')
     OR EXISTS (SELECT 1 FROM public.auto_review_reconciliation_requests
                WHERE document_id = '5e200000-0000-0000-0000-000000000002') THEN
    RAISE EXCEPTION 'FALHOU: campo que volta deveria enfileirar só quem tem um dos valores';
  END IF;
  RAISE NOTICE 'OK: campo que volta ao schema enfileira só quem usa os valores';
END;
$$;

-- (j) Apagar o projeto com equivalencia nao falha no arquivamento.
DELETE FROM public.projects WHERE id = '5e100000-0000-0000-0000-000000000002';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.value_equivalences WHERE project_id = '5e100000-0000-0000-0000-000000000002')
     OR EXISTS (SELECT 1 FROM public.value_equivalence_history_entries WHERE project_id = '5e100000-0000-0000-0000-000000000002') THEN
    RAISE EXCEPTION 'FALHOU: o cascade do projeto deveria levar as equivalencias sem historico orfao';
  END IF;
  RAISE NOTICE 'OK: cascade do projeto';
END;
$$;

ROLLBACK;
