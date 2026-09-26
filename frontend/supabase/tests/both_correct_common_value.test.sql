-- "Ambos corretos" grava o valor comum quando o veredito diverge das
-- respostas humanas atuais e elas concordam entre si e com o LLM (#758).
--
-- Blocos:
--   (a) o RPC: `set_error_resolution` calcula o valor comum e só aceita a
--       decisão quando a expectativa do cliente (`p_value`) é esse valor; a
--       prévia `both_correct_value` devolve o mesmo cálculo; `read_error_resolutions`
--       não derruba a decisão com valor próprio quando a fonte perde a
--       validade; o CHECK aceita valor em "Ambos corretos";
--   (b) matriz das funções puras, cópia SQL de `answersAgree`,
--       `verdictMatchesAnswer` e `normalizeText` (frontend/src/lib). Os casos
--       espelham os do teste unitário `both-correct-common-value.test.ts`,
--       para que as duas cópias falhem juntas;
--   (c) grants: as funções internas ficam fechadas para o cliente.
--
-- Roda numa transação e não deixa fixture no banco local.

BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('b0c00000-0000-0000-0000-000000000001', 'common-owner@example.test'),
  ('b0c00000-0000-0000-0000-000000000002', 'common-coder-1@example.test'),
  ('b0c00000-0000-0000-0000-000000000003', 'common-coder-2@example.test'),
  ('b0c00000-0000-0000-0000-000000000004', 'common-outsider@example.test');
INSERT INTO public.clerk_user_mapping (clerk_user_id, supabase_user_id, access_sync_version)
  SELECT id::TEXT, id, 1 FROM auth.users WHERE id::TEXT LIKE 'b0c00000-%';

-- Campos (um por cenário), todos com hash, como o schema grava hoje:
--   s   single: LLM e os dois pesquisadores dizem A (um com caixa e espaço
--       diferentes), o veredito diz B. Valor comum: a resposta do LLM.
--   s2  single: os pesquisadores discordam entre si. Sem valor.
--   s3  single: o veredito já é a resposta do LLM. Sem valor.
--   s4  single sem condição, todos em branco. Branco só é resposta em
--       condicional: sem valor.
--   s5  single: todos dizem Z, que não é opção da pergunta. Sem valor.
--   m   multi: a mesma seleção em ordens diferentes. Valor: o array do LLM.
--   c   single condicional: o LLM deixou de fora e os pesquisadores também.
--       Valor: o branco canônico "".
--   cm  multi condicional: LLM [] e pesquisadores sem a chave. Valor: [].
--   t   texto: acento e caixa, e um par "=" vigente liga a terceira forma.
--   t2  texto: um par "=" vigente liga o LLM a uma resposta que casa com o
--       veredito. A métrica conta o LLM como certo: sem valor.
--   t3  texto: o par "=" que juntaria os pesquisadores ao LLM tem snapshot
--       velho e não vale. Sem valor.
INSERT INTO public.projects (id, name, created_by, automation_mode, pydantic_fields) VALUES
  ('b0c10000-0000-0000-0000-000000000001', 'Common value test', 'b0c00000-0000-0000-0000-000000000001', 'compare_llm',
   '[{"id":"b0f10000-0000-4000-8000-000000000001","name":"s","type":"single","options":["A","B"],"description":"Única","hash":"s00000000001"},
     {"id":"b0f10000-0000-4000-8000-000000000002","name":"s2","type":"single","options":["A","B"],"description":"Discordam","hash":"s00000000002"},
     {"id":"b0f10000-0000-4000-8000-000000000003","name":"s3","type":"single","options":["A","B"],"description":"Veredito igual","hash":"s00000000003"},
     {"id":"b0f10000-0000-4000-8000-000000000004","name":"s4","type":"single","options":["A","B"],"description":"Branco sem condição","hash":"s00000000004"},
     {"id":"b0f10000-0000-4000-8000-000000000005","name":"s5","type":"single","options":["A","B"],"description":"Fora das opções","hash":"s00000000005"},
     {"id":"b0f10000-0000-4000-8000-000000000006","name":"m","type":"multi","options":["A","B","C"],"description":"Múltipla","hash":"m00000000001"},
     {"id":"b0f10000-0000-4000-8000-000000000007","name":"g0","type":"single","options":["Sim","Não"],"description":"Gatilho","hash":"g00000000001"},
     {"id":"b0f10000-0000-4000-8000-000000000008","name":"c","type":"single","options":["A","B"],"description":"Condicional","condition":{"field":"g0","equals":"Sim"},"hash":"c00000000001"},
     {"id":"b0f10000-0000-4000-8000-000000000009","name":"cm","type":"multi","options":["A","B"],"description":"Condicional múltipla","condition":{"field":"g0","equals":"Sim"},"hash":"c00000000002"},
     {"id":"b0f10000-0000-4000-8000-000000000010","name":"t","type":"text","options":null,"description":"Livre","hash":"t00000000001"},
     {"id":"b0f10000-0000-4000-8000-000000000011","name":"t2","type":"text","options":null,"description":"Par com o veredito","hash":"t00000000002"},
     {"id":"b0f10000-0000-4000-8000-000000000012","name":"t3","type":"text","options":null,"description":"Par velho","hash":"t00000000003"}]');
INSERT INTO public.project_members (project_id, user_id, role, can_resolve) VALUES
  ('b0c10000-0000-0000-0000-000000000001', 'b0c00000-0000-0000-0000-000000000002', 'pesquisador', false),
  ('b0c10000-0000-0000-0000-000000000001', 'b0c00000-0000-0000-0000-000000000003', 'pesquisador', false);
INSERT INTO public.documents (id, project_id, title, text) VALUES
  ('b0c20000-0000-0000-0000-000000000001', 'b0c10000-0000-0000-0000-000000000001', 'Documento', 'Texto');

-- L: LLM; H1 e H2: pesquisadores correntes; HV: versão anterior de H2, fora
-- de `is_latest`, com as respostas que a arbitragem antiga escolheu.
INSERT INTO public.responses (id, project_id, document_id, respondent_id, respondent_type, is_latest, answers) VALUES
  ('b0c30000-0000-0000-0000-000000000001', 'b0c10000-0000-0000-0000-000000000001', 'b0c20000-0000-0000-0000-000000000001', NULL, 'llm', true,
   '{"s":"A","s2":"A","s3":"A","s4":"","s5":"Z","m":["B","A"],"g0":"Não","cm":[],"t":"Adalimumabe","t2":"Dipirona","t3":"Soro"}'),
  ('b0c30000-0000-0000-0000-000000000002', 'b0c10000-0000-0000-0000-000000000001', 'b0c20000-0000-0000-0000-000000000001', 'b0c00000-0000-0000-0000-000000000002', 'humano', true,
   '{"s":"A","s2":"A","s3":"A","s4":"","s5":"Z","m":["A","B"],"g0":"Não","t":"adalimumabé ","t2":"Dipirona","t3":"soro fisiologico"}'),
  ('b0c30000-0000-0000-0000-000000000003', 'b0c10000-0000-0000-0000-000000000001', 'b0c20000-0000-0000-0000-000000000001', 'b0c00000-0000-0000-0000-000000000003', 'humano', true,
   '{"s":" a","s2":"B","s3":"A","s4":"","s5":"Z","m":["B","A"],"g0":"Não","t":"ADA","t2":"dipirona","t3":"Soro fisiológico"}'),
  ('b0c30000-0000-0000-0000-000000000004', 'b0c10000-0000-0000-0000-000000000001', 'b0c20000-0000-0000-0000-000000000001', 'b0c00000-0000-0000-0000-000000000003', 'humano', false,
   '{"s":"B","s2":"B","s4":"A","s5":"A","m":["C"],"g0":"Sim","c":"A","cm":["A"],"t":"Outro remédio","t2":"Metamizol","t3":"Glicose"}');

INSERT INTO public.response_equivalences (project_id, document_id, field_name, response_a_id, response_b_id,
  reviewer_id, response_a_answer_snapshot, response_b_answer_snapshot) VALUES
  -- t: H1 = H2, vigente.
  ('b0c10000-0000-0000-0000-000000000001', 'b0c20000-0000-0000-0000-000000000001', 't',
   'b0c30000-0000-0000-0000-000000000002', 'b0c30000-0000-0000-0000-000000000003', 'b0c00000-0000-0000-0000-000000000001',
   '"adalimumabé "', '"ADA"'),
  -- t2: LLM = HV, vigente; HV casa com o veredito.
  ('b0c10000-0000-0000-0000-000000000001', 'b0c20000-0000-0000-0000-000000000001', 't2',
   'b0c30000-0000-0000-0000-000000000001', 'b0c30000-0000-0000-0000-000000000004', 'b0c00000-0000-0000-0000-000000000001',
   '"Dipirona"', '"Metamizol"'),
  -- t3: LLM = H1, com snapshot de H1 que não é mais a resposta dele.
  ('b0c10000-0000-0000-0000-000000000001', 'b0c20000-0000-0000-0000-000000000001', 't3',
   'b0c30000-0000-0000-0000-000000000001', 'b0c30000-0000-0000-0000-000000000002', 'b0c00000-0000-0000-0000-000000000001',
   '"Soro"', '"soro fisiologico"');
-- O gatilho de INSERT carimba o snapshot com a resposta atual, e o de UPDATE
-- em `responses` apaga o par cuja resposta muda. O par com snapshot velho que
-- a métrica descarta (`filterCurrentEquivalencePairs`) é montado à mão.
UPDATE public.response_equivalences SET response_b_answer_snapshot = '"outra coisa"'
WHERE field_name = 't3' AND project_id = 'b0c10000-0000-0000-0000-000000000001';

INSERT INTO public.reviews (id, project_id, document_id, field_name, reviewer_id, verdict, chosen_response_id)
SELECT ('b0c40000-0000-0000-0000-0000000000' || lpad(n::TEXT, 2, '0'))::UUID,
  'b0c10000-0000-0000-0000-000000000001', 'b0c20000-0000-0000-0000-000000000001', f, 'b0c00000-0000-0000-0000-000000000001', v,
  CASE WHEN f = 's3' THEN 'b0c30000-0000-0000-0000-000000000002'::UUID ELSE 'b0c30000-0000-0000-0000-000000000004'::UUID END
FROM (VALUES (1, 's', 'B'), (2, 's2', 'B'), (3, 's3', 'A'), (4, 's4', 'A'), (5, 's5', 'A'), (6, 'm', '{"C":true}'),
             (7, 'c', 'A'), (8, 'cm', '{"A":true}'), (9, 't', 'Outro remédio'), (10, 't2', 'Metamizol'), (11, 't3', 'Glicose'))
  AS v(n, f, v);

-- Os contextos, abertos como o dono (creator) do projeto.
CREATE TEMP TABLE common_cases (field TEXT PRIMARY KEY, review UUID, expected JSONB, context JSONB, preview JSONB) ON COMMIT DROP;
INSERT INTO common_cases (field, review, expected) VALUES
  ('s', 'b0c40000-0000-0000-0000-000000000001', '"A"'),
  ('s2', 'b0c40000-0000-0000-0000-000000000002', NULL),
  ('s3', 'b0c40000-0000-0000-0000-000000000003', NULL),
  ('s4', 'b0c40000-0000-0000-0000-000000000004', NULL),
  ('s5', 'b0c40000-0000-0000-0000-000000000005', NULL),
  ('m', 'b0c40000-0000-0000-0000-000000000006', '["B","A"]'),
  ('c', 'b0c40000-0000-0000-0000-000000000007', '""'),
  ('cm', 'b0c40000-0000-0000-0000-000000000008', '[]'),
  ('t', 'b0c40000-0000-0000-0000-000000000009', '"Adalimumabe"'),
  ('t2', 'b0c40000-0000-0000-0000-000000000010', NULL),
  ('t3', 'b0c40000-0000-0000-0000-000000000011', NULL);
GRANT ALL ON common_cases TO authenticated;

SELECT set_config('request.jwt.claims', '{"sub":"b0c00000-0000-0000-0000-000000000001","supabase_uid":"b0c00000-0000-0000-0000-000000000001"}', true);
SET LOCAL ROLE authenticated;
UPDATE common_cases SET context = public.llm_error_context(
  'b0c10000-0000-0000-0000-000000000001', 'b0c20000-0000-0000-0000-000000000001', field,
  'b0c30000-0000-0000-0000-000000000001', 'b0c30000-0000-0000-0000-000000000002', 'comparacao', review);
RESET ROLE;

-- (a) O RPC grava o valor comum, e só ele.
SELECT set_config('request.jwt.claims', '{"sub":"b0c00000-0000-0000-0000-000000000001","supabase_uid":"b0c00000-0000-0000-0000-000000000001"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  P CONSTANT UUID := 'b0c10000-0000-0000-0000-000000000001';
  D CONSTANT UUID := 'b0c20000-0000-0000-0000-000000000001';
  kase RECORD;
  item RECORD;
BEGIN
  -- O caso principal primeiro: no código anterior ele falha com a mensagem que
  -- descreve o defeito (decisão gravada sem o valor comum).
  FOR kase IN SELECT * FROM common_cases ORDER BY field <> 's', field LOOP
    IF kase.context IS NULL THEN RAISE EXCEPTION 'FALHOU: fixture sem contexto em %', kase.field; END IF;
    -- A decisão com a expectativa certa grava exatamente o valor esperado.
    PERFORM public.set_error_resolution(P, D, kase.field, 'both_correct', kase.context, NULL, NULL, 'Conferido', kase.expected);
    SELECT * INTO item FROM public.read_error_resolutions(P) AS r WHERE r.field_name = kase.field;
    IF item.decision IS DISTINCT FROM 'both_correct' OR item.approved_value IS DISTINCT FROM kase.expected THEN
      RAISE EXCEPTION 'FALHOU: "Ambos corretos" em % gravou % (esperado %)', kase.field, item.approved_value, kase.expected;
    END IF;
    IF item.current_context IS DISTINCT FROM item.context THEN
      RAISE EXCEPTION 'FALHOU: decisão recém-gravada em % já nasce stale', kase.field;
    END IF;
    -- A expectativa errada (sem valor quando há, ou um valor qualquer) é recusada.
    BEGIN
      PERFORM public.set_error_resolution(P, D, kase.field, 'both_correct', kase.context, item.id, item.resolved_at, NULL,
        CASE WHEN kase.expected IS NULL THEN '"A"'::JSONB END);
      RAISE EXCEPTION 'FALHOU: "Ambos corretos" em % aceitou expectativa diferente do valor comum', kase.field;
    EXCEPTION WHEN serialization_failure THEN NULL;
    END;
    BEGIN
      PERFORM public.set_error_resolution(P, D, kase.field, 'both_correct', kase.context, item.id, item.resolved_at, NULL, '"B"'::JSONB);
      RAISE EXCEPTION 'FALHOU: "Ambos corretos" em % aceitou valor forjado pelo cliente', kase.field;
    EXCEPTION WHEN serialization_failure THEN NULL;
    END;
    PERFORM public.set_error_resolution(P, D, kase.field, NULL, NULL, item.id, item.resolved_at);
  END LOOP;
  RAISE NOTICE 'OK: "Ambos corretos" grava o valor comum e recusa o valor do cliente';
END $$;
RESET ROLE;

-- A prévia do diálogo devolve o mesmo cálculo; quem não é do projeto não vê.
SELECT set_config('request.jwt.claims', '{"sub":"b0c00000-0000-0000-0000-000000000003","supabase_uid":"b0c00000-0000-0000-0000-000000000003"}', true);
SET LOCAL ROLE authenticated;
UPDATE common_cases SET preview = public.both_correct_value(context);
RESET ROLE;
DO $$
DECLARE kase RECORD;
BEGIN
  FOR kase IN SELECT * FROM common_cases LOOP
    IF kase.preview IS DISTINCT FROM kase.expected THEN
      RAISE EXCEPTION 'FALHOU: prévia de % devolveu % (esperado %)', kase.field, kase.preview, kase.expected;
    END IF;
  END LOOP;
  RAISE NOTICE 'OK: a prévia é o mesmo valor que o RPC grava';
END $$;
SELECT set_config('request.jwt.claims', '{"sub":"b0c00000-0000-0000-0000-000000000004","supabase_uid":"b0c00000-0000-0000-0000-000000000004"}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF public.both_correct_value((SELECT context FROM common_cases WHERE field = 's')) IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU: prévia vazou para quem não é do projeto';
  END IF;
END $$;
RESET ROLE;

-- Prévia de contexto que já mudou: recusa, em vez de prometer valor velho.
SELECT set_config('request.jwt.claims', '{"sub":"b0c00000-0000-0000-0000-000000000001","supabase_uid":"b0c00000-0000-0000-0000-000000000001"}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.both_correct_value(jsonb_set((SELECT context FROM common_cases WHERE field = 's'), '{llm_value,value}', '"B"'));
    RAISE EXCEPTION 'FALHOU: prévia aceitou contexto adulterado';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
END $$;
RESET ROLE;

-- Um pesquisador muda a resposta: o mesmo contexto do LLM e de H1 passa a não
-- ter valor comum, e a expectativa antiga é recusada.
UPDATE public.responses SET answers = answers || '{"s":"B"}' WHERE id = 'b0c30000-0000-0000-0000-000000000003';
SELECT set_config('request.jwt.claims', '{"sub":"b0c00000-0000-0000-0000-000000000001","supabase_uid":"b0c00000-0000-0000-0000-000000000001"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE c JSONB;
BEGIN
  c := public.llm_error_context('b0c10000-0000-0000-0000-000000000001', 'b0c20000-0000-0000-0000-000000000001', 's',
    'b0c30000-0000-0000-0000-000000000001', 'b0c30000-0000-0000-0000-000000000002', 'comparacao', 'b0c40000-0000-0000-0000-000000000001');
  IF public.both_correct_value(c) IS NOT NULL THEN RAISE EXCEPTION 'FALHOU: pesquisadores discordando ainda têm valor comum'; END IF;
  BEGIN
    PERFORM public.set_error_resolution('b0c10000-0000-0000-0000-000000000001', 'b0c20000-0000-0000-0000-000000000001', 's',
      'both_correct', c, NULL, NULL, NULL, '"A"'::JSONB);
    RAISE EXCEPTION 'FALHOU: expectativa antiga aceita depois que um pesquisador mudou a resposta';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
  RAISE NOTICE 'OK: o valor comum lê as respostas vigentes de todos os pesquisadores';
END $$;
RESET ROLE;
UPDATE public.responses SET answers = answers || '{"s":" a"}' WHERE id = 'b0c30000-0000-0000-0000-000000000003';

-- "Ambos corretos" com o LLM ausente continua exigindo o valor comum: sem ele,
-- não há o que declarar correto (c sem o branco comum).
UPDATE public.responses SET answers = answers || '{"c":"A"}' WHERE id = 'b0c30000-0000-0000-0000-000000000003';
SELECT set_config('request.jwt.claims', '{"sub":"b0c00000-0000-0000-0000-000000000001","supabase_uid":"b0c00000-0000-0000-0000-000000000001"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE c JSONB;
BEGIN
  c := public.llm_error_context('b0c10000-0000-0000-0000-000000000001', 'b0c20000-0000-0000-0000-000000000001', 'c',
    'b0c30000-0000-0000-0000-000000000001', 'b0c30000-0000-0000-0000-000000000002', 'comparacao', 'b0c40000-0000-0000-0000-000000000007');
  BEGIN
    PERFORM public.set_error_resolution('b0c10000-0000-0000-0000-000000000001', 'b0c20000-0000-0000-0000-000000000001', 'c',
      'both_correct', c, NULL, NULL, NULL, NULL);
    RAISE EXCEPTION 'FALHOU: "Ambos corretos" sem resposta do LLM e sem branco comum foi aceito';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  RAISE NOTICE 'OK: LLM ausente só entra no branco comum de condicional';
END $$;
RESET ROLE;
UPDATE public.responses SET answers = answers - 'c' WHERE id = 'b0c30000-0000-0000-0000-000000000003';

-- A decisão com valor próprio não depende da fonte: com a pergunta mudada, o
-- contexto calculado depois da mudança segue valendo para ela, e cai para a
-- que não tem valor. Mesmo desenho de reviews_field_hash.test.sql (e).
UPDATE public.projects
SET pydantic_fields = (
  SELECT jsonb_agg(CASE WHEN f->>'name' = 's' THEN f || '{"description":"Única, reescrita","hash":"s99999999999"}' ELSE f END ORDER BY i)
  FROM jsonb_array_elements(pydantic_fields) WITH ORDINALITY AS t(f, i)),
    schema_revision = schema_revision + 1
WHERE id = 'b0c10000-0000-0000-0000-000000000001';
CREATE TEMP TABLE common_reopened (context JSONB) ON COMMIT DROP;
GRANT ALL ON common_reopened TO authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"b0c00000-0000-0000-0000-000000000001","supabase_uid":"b0c00000-0000-0000-0000-000000000001"}', true);
SET LOCAL ROLE authenticated;
INSERT INTO common_reopened SELECT public.llm_error_context('b0c10000-0000-0000-0000-000000000001', 'b0c20000-0000-0000-0000-000000000001', 's',
  'b0c30000-0000-0000-0000-000000000001', 'b0c30000-0000-0000-0000-000000000002', 'comparacao', 'b0c40000-0000-0000-0000-000000000001', false);
RESET ROLE;
DELETE FROM public.error_resolutions WHERE project_id = 'b0c10000-0000-0000-0000-000000000001';
INSERT INTO public.documents (id, project_id, title, text) VALUES
  ('b0c20000-0000-0000-0000-000000000002', 'b0c10000-0000-0000-0000-000000000001', 'Documento sem decisão', 'Texto');
INSERT INTO public.error_resolutions (project_id, document_id, field_name, decision, context, approved_value, resolved_by)
SELECT 'b0c10000-0000-0000-0000-000000000001', 'b0c20000-0000-0000-0000-000000000001', 's', 'both_correct', context, '"A"', 'b0c00000-0000-0000-0000-000000000001'
FROM common_reopened;
SELECT set_config('request.jwt.claims', '{"sub":"b0c00000-0000-0000-0000-000000000001","supabase_uid":"b0c00000-0000-0000-0000-000000000001"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE item RECORD;
BEGIN
  SELECT * INTO item FROM public.read_error_resolutions('b0c10000-0000-0000-0000-000000000001') AS r WHERE r.field_name = 's';
  IF item.context IS NULL THEN RAISE EXCEPTION 'FALHOU: fixture sem contexto reaberto'; END IF;
  IF item.current_context IS DISTINCT FROM item.context THEN
    RAISE EXCEPTION 'FALHOU: "Ambos corretos" com valor próprio caiu com a fonte inválida';
  END IF;
END $$;
RESET ROLE;
UPDATE public.error_resolutions SET approved_value = NULL WHERE field_name = 's' AND project_id = 'b0c10000-0000-0000-0000-000000000001';
SELECT set_config('request.jwt.claims', '{"sub":"b0c00000-0000-0000-0000-000000000001","supabase_uid":"b0c00000-0000-0000-0000-000000000001"}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.read_error_resolutions('b0c10000-0000-0000-0000-000000000001') AS r
             WHERE r.field_name = 's' AND r.current_context IS NOT NULL) THEN
    RAISE EXCEPTION 'FALHOU: "Ambos corretos" sem valor continua valendo com a fonte inválida';
  END IF;
  RAISE NOTICE 'OK: só "Ambos corretos" sem valor depende da fonte';
END $$;
RESET ROLE;

-- CHECK: "Ambos corretos" aceita valor; as decisões sem valor seguem sem.
DO $$
BEGIN
  INSERT INTO public.error_resolutions (project_id, document_id, field_name, resolved_by, decision, context, approved_value)
  VALUES ('b0c10000-0000-0000-0000-000000000001', 'b0c20000-0000-0000-0000-000000000002', 'zz',
          'b0c00000-0000-0000-0000-000000000001', 'both_correct', '{}'::jsonb, '"x"'::jsonb);
  BEGIN
    INSERT INTO public.error_resolutions (project_id, document_id, field_name, resolved_by, decision, context, approved_value)
    VALUES ('b0c10000-0000-0000-0000-000000000001', 'b0c20000-0000-0000-0000-000000000002', 'zy',
            'b0c00000-0000-0000-0000-000000000001', 'both_correct', '{}'::jsonb, 'null'::jsonb);
    RAISE EXCEPTION 'FALHOU: "Ambos corretos" com JSON null passou no CHECK';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.error_resolutions (project_id, document_id, field_name, resolved_by, decision, context, approved_value)
    VALUES ('b0c10000-0000-0000-0000-000000000001', 'b0c20000-0000-0000-0000-000000000002', 'zx',
            'b0c00000-0000-0000-0000-000000000001', 'llm_correct', '{}'::jsonb, '"x"'::jsonb);
    RAISE EXCEPTION 'FALHOU: "Erro humano" com approved_value passou no CHECK';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.error_resolutions (project_id, document_id, field_name, resolved_by, decision, context, approved_value)
    VALUES ('b0c10000-0000-0000-0000-000000000001', 'b0c20000-0000-0000-0000-000000000002', 'zw',
            'b0c00000-0000-0000-0000-000000000001', 'discussion', '{}'::jsonb, '"x"'::jsonb);
    RAISE EXCEPTION 'FALHOU: "Em discussão" com approved_value passou no CHECK';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.error_resolutions (project_id, document_id, field_name, resolved_by, decision, context)
    VALUES ('b0c10000-0000-0000-0000-000000000001', 'b0c20000-0000-0000-0000-000000000002', 'zv',
            'b0c00000-0000-0000-0000-000000000001', 'researchers_correct', '{}'::jsonb);
    RAISE EXCEPTION 'FALHOU: "Erro do LLM" sem approved_value passou no CHECK';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'OK: CHECK aceita valor em "Ambos corretos" e segue fechado nas demais';
END $$;

-- Fonte de auto-revisão nunca tem valor comum: o veredito é a própria
-- resposta humana do contexto.
DO $$
BEGIN
  IF public.both_correct_common_value((SELECT context FROM common_cases WHERE field = 'm')
       || '{"source":{"kind":"auto_revisao","id":"b0c40000-0000-0000-0000-000000000006"}}') IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU: auto-revisão ganhou valor comum';
  END IF;
  RAISE NOTICE 'OK: auto-revisão fica fora do valor comum';
END $$;

-- (b) Matriz das funções puras. Mesmos casos de both-correct-common-value.test.ts.
DO $$
DECLARE
  text_field CONSTANT JSONB := '{"name":"t","type":"text"}';
  multi_field CONSTANT JSONB := '{"name":"m","type":"multi","options":["A","B","C"]}';
  kase RECORD;
BEGIN
  FOR kase IN SELECT * FROM (VALUES
      ('  Adalimumabé  ', 'adalimumabe'),
      (E'ÁRVORE\u00A0\u2003 Grande', 'arvore grande'),
      ('Ação', 'acao'),
      (E'a\tb\nc', 'a b c'),
      ('a^b`c', 'abc'),
      (E'x\uFEFF', 'x'),
      ('', '')) AS v(input, expected) LOOP
    IF public.answer_normalize_text(kase.input) IS DISTINCT FROM kase.expected THEN
      RAISE EXCEPTION 'FALHOU: answer_normalize_text(%) = % (esperado %)', kase.input, public.answer_normalize_text(kase.input), kase.expected;
    END IF;
  END LOOP;

  FOR kase IN SELECT * FROM (VALUES
      ('texto: acento e caixa', text_field, '"Ação"'::JSONB, '" acao "'::JSONB, true),
      ('texto: diferente', text_field, '"A"'::JSONB, '"B"'::JSONB, false),
      ('branco: ausente e vazio', text_field, NULL::JSONB, '""'::JSONB, true),
      ('branco: null e espaço', text_field, 'null'::JSONB, '" "'::JSONB, true),
      ('branco contra resposta', text_field, NULL::JSONB, '"A"'::JSONB, false),
      ('multi: ordem não importa', multi_field, '["B","A"]'::JSONB, '["A","B"]'::JSONB, true),
      ('multi: conjunto diferente', multi_field, '["A"]'::JSONB, '["A","B"]'::JSONB, false),
      ('multi: [] é branco', multi_field, '[]'::JSONB, NULL::JSONB, true),
      ('multi legado em texto compara por texto', multi_field, '"A"'::JSONB, '"B"'::JSONB, false),
      ('objeto: mesmas chaves', text_field, '{"anos":"2"}'::JSONB, '{"anos":"2"}'::JSONB, true),
      ('objeto: valor diferente', text_field, '{"anos":"2"}'::JSONB, '{"anos":"3"}'::JSONB, false),
      ('array em texto: normaliza os itens', text_field, '["Ação"]'::JSONB, '["acao"]'::JSONB, true)
    ) AS v(label, field, a, b, expected) LOOP
    IF public.answers_agree(kase.field, kase.a, kase.b) IS DISTINCT FROM kase.expected THEN
      RAISE EXCEPTION 'FALHOU: answers_agree %', kase.label;
    END IF;
  END LOOP;

  FOR kase IN SELECT * FROM (VALUES
      ('texto: igual normalizado', text_field, 'acao', '"Ação"'::JSONB, true),
      ('texto: diferente', text_field, 'B', '"A"'::JSONB, false),
      ('texto: veredito em branco e resposta ausente', text_field, ' ', NULL::JSONB, true),
      ('texto: veredito em branco e resposta preenchida', text_field, '', '"A"'::JSONB, false),
      ('data parcial exibida no card', text_field, '—/03/2024', '"XX/03/2024"'::JSONB, true),
      ('subcampos exibidos no card', text_field, 'anos: 2, meses: 3', '{"anos":"2","meses":"3"}'::JSONB, true),
      ('lista exibida no card', text_field, 'A, B', '["A","B"]'::JSONB, true),
      ('multi: JSON do veredito', multi_field, '{"A":true,"B":true,"C":false}', '["B","A"]'::JSONB, true),
      ('multi: JSON do veredito diferente', multi_field, '{"A":true}', '["A","B"]'::JSONB, false),
      ('multi: texto votado em card', multi_field, 'A, C', '["C","A"]'::JSONB, true),
      ('multi: veredito vazio e resposta vazia', multi_field, '', '[]'::JSONB, true),
      ('multi: veredito vazio e resposta marcada', multi_field, '', '["A"]'::JSONB, false),
      ('texto: resposta ausente e veredito preenchido', text_field, 'A', NULL::JSONB, false),
      ('subcampo numérico: 2.0 exibido como 2', text_field, 'dose: 2', '{"dose":2.0}'::JSONB, true),
      ('número: 1.50 exibido como 1.5', text_field, '1.5', '1.50'::JSONB, true),
      ('número: 1e21 exibido como 1e+21', text_field, '1e+21', '1e21'::JSONB, true),
      ('número: 1e21 não é exibido por extenso', text_field, '1000000000000000000000', '1e21'::JSONB, false)
    ) AS v(label, field, verdict, answer, expected) LOOP
    IF public.verdict_matches_answer(kase.field, kase.verdict, kase.answer) IS DISTINCT FROM kase.expected THEN
      RAISE EXCEPTION 'FALHOU: verdict_matches_answer %', kase.label;
    END IF;
  END LOOP;
  -- O texto do card (`formatCardAnswer`) escreve número como o `String()` do
  -- JS: o JSON é lido como double, sem zero decimal à direita e com expoente
  -- fora de [1e-6, 1e21).
  FOR kase IN SELECT * FROM (VALUES
      ('2.0', '2'),
      ('1.50', '1.5'),
      ('1e21', '1e+21'),
      ('1E+21', '1e+21'),
      ('1e20', '100000000000000000000'),
      ('-1.5e-7', '-1.5e-7'),
      ('0.000001', '0.000001'),
      ('0.0000001', '1e-7'),
      ('-0', '0'),
      ('0', '0'),
      ('123456789012345678901', '123456789012345680000'),
      ('{"dose":2.0}', 'dose: 2'),
      ('[1.50,true,null,"x"]', '1.5, true, , x'),
      ('{"a":1e21,"b":false}', 'a: 1e+21, b: false'),
      ('12.340e1', '123.4'),
      ('1e400', 'Infinity'),
      ('-1e400', '-Infinity'),
      ('1e-400', '0'),
      ('0.1', '0.1'),
      ('1.0000000000000002', '1.0000000000000002')
    ) AS v(answer, expected) LOOP
    IF public.answer_card_text(kase.answer::JSONB) IS DISTINCT FROM kase.expected THEN
      RAISE EXCEPTION 'FALHOU: answer_card_text(%) = % (esperado %)', kase.answer, public.answer_card_text(kase.answer::JSONB), kase.expected;
    END IF;
  END LOOP;
  RAISE NOTICE 'OK: matriz das funções puras';
END $$;

-- A forma do número não depende da sessão: com `extra_float_digits` baixo, o
-- texto do float8 sairia arredondado ("1" no lugar de "1.0000000000000002").
SET LOCAL extra_float_digits = 0;
DO $$
BEGIN
  IF public.answer_card_text('1.0000000000000002'::JSONB) IS DISTINCT FROM '1.0000000000000002' THEN
    RAISE EXCEPTION 'FALHOU: answer_card_text depende de extra_float_digits da sessão: %', public.answer_card_text('1.0000000000000002'::JSONB);
  END IF;
  RAISE NOTICE 'OK: a forma do número não depende da sessão';
END $$;
RESET extra_float_digits;

-- (c) Grants: só a prévia é do cliente.
DO $$
DECLARE fn TEXT;
BEGIN
  FOREACH fn IN ARRAY ARRAY['public.both_correct_common_value(jsonb)', 'public.answer_normalize_text(text)', 'public.answer_js_number(numeric)',
      'public.answers_agree(jsonb,jsonb,jsonb)', 'public.verdict_matches_answer(jsonb,text,jsonb)'] LOOP
    IF has_function_privilege('authenticated', fn, 'EXECUTE') OR has_function_privilege('anon', fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'FALHOU: % exposta ao cliente', fn;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('authenticated', 'public.both_correct_value(jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.both_correct_value(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FALHOU: grants da prévia both_correct_value';
  END IF;
  RAISE NOTICE 'OK: grants';
END $$;

ROLLBACK;
