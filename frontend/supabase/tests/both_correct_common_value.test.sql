-- "Ambos corretos" grava o valor comum quando o veredito ficou para tras (#758).
--
-- Quem decide se ha valor comum e a fila (`bothCorrectCommonValue`); o RPC
-- confere o que o contexto da decisao prova. Blocos:
--   (a) o RPC grava o valor comum quando ele e a resposta do LLM do contexto
--       (ou o branco canonico de condicional com o LLM em branco), e recusa
--       o resto: valor que nao e o do LLM, branco fora de condicional, valor
--       fora do dominio, arbitragem que escolheu a propria resposta do LLM. A
--       fonte de auto-revisao esta em llm_error_decisions.test.sql, que ja tem
--       essa fixture;
--   (b) `read_error_resolutions` nao derruba a decisao com valor proprio
--       quando a fonte perde a validade;
--   (c) o CHECK aceita valor em "Ambos corretos";
--   (d) grants: a funcao interna fica fechada para o cliente.
--
-- Roda numa transacao e nao deixa fixture no banco local.

BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('b0c00000-0000-0000-0000-000000000001', 'common-owner@example.test'),
  ('b0c00000-0000-0000-0000-000000000002', 'common-coder-1@example.test'),
  ('b0c00000-0000-0000-0000-000000000003', 'common-coder-2@example.test');
INSERT INTO public.clerk_user_mapping (clerk_user_id, supabase_user_id, access_sync_version)
  SELECT id::TEXT, id, 1 FROM auth.users WHERE id::TEXT LIKE 'b0c00000-%';

-- Campos (um por cenario), todos com hash, como o schema grava hoje:
--   s   single: LLM diz A, o veredito B. Valor comum: "A".
--   s4  single sem condicao, LLM em branco. Branco so e resposta em
--       condicional: nao ha valor.
--   s5  single: o LLM diz Z, que nao e opcao da pergunta. Nao ha valor.
--   s6  single: a arbitragem escolheu a propria resposta do LLM, e o veredito
--       e ela, mesmo com o texto "B". Nao ha valor.
--   m   multi: valor comum e o array do LLM.
--   c   single condicional: o LLM deixou de fora. Valor: o branco canonico "".
--   cm  multi condicional: LLM []. Valor: [].
--   t   texto: H2 diz "ADA", que a fila liga ao LLM por par "=". O valor
--       gravado e a resposta do LLM, nao o texto de quem esta no par.
INSERT INTO public.projects (id, name, created_by, automation_mode, pydantic_fields) VALUES
  ('b0c10000-0000-0000-0000-000000000001', 'Common value test', 'b0c00000-0000-0000-0000-000000000001', 'compare_llm',
   '[{"id":"b0f10000-0000-4000-8000-000000000001","name":"s","type":"single","options":["A","B"],"description":"Única","hash":"s00000000001"},
     {"id":"b0f10000-0000-4000-8000-000000000004","name":"s4","type":"single","options":["A","B"],"description":"Branco sem condição","hash":"s00000000004"},
     {"id":"b0f10000-0000-4000-8000-000000000005","name":"s5","type":"single","options":["A","B"],"description":"Fora das opções","hash":"s00000000005"},
     {"id":"b0f10000-0000-4000-8000-000000000006","name":"m","type":"multi","options":["A","B","C"],"description":"Múltipla","hash":"m00000000001"},
     {"id":"b0f10000-0000-4000-8000-000000000007","name":"g0","type":"single","options":["Sim","Não"],"description":"Gatilho","hash":"g00000000001"},
     {"id":"b0f10000-0000-4000-8000-000000000008","name":"c","type":"single","options":["A","B"],"description":"Condicional","condition":{"field":"g0","equals":"Sim"},"hash":"c00000000001"},
     {"id":"b0f10000-0000-4000-8000-000000000009","name":"cm","type":"multi","options":["A","B"],"description":"Condicional múltipla","condition":{"field":"g0","equals":"Sim"},"hash":"c00000000002"},
     {"id":"b0f10000-0000-4000-8000-000000000010","name":"t","type":"text","options":null,"description":"Livre","hash":"t00000000001"},
     {"id":"b0f10000-0000-4000-8000-000000000013","name":"s6","type":"single","options":["A","B"],"description":"Escolhida é o LLM","hash":"s00000000006"}]');
INSERT INTO public.project_members (project_id, user_id, role, can_resolve) VALUES
  ('b0c10000-0000-0000-0000-000000000001', 'b0c00000-0000-0000-0000-000000000002', 'pesquisador', false),
  ('b0c10000-0000-0000-0000-000000000001', 'b0c00000-0000-0000-0000-000000000003', 'pesquisador', false);
INSERT INTO public.documents (id, project_id, title, text) VALUES
  ('b0c20000-0000-0000-0000-000000000001', 'b0c10000-0000-0000-0000-000000000001', 'Documento', 'Texto');

-- L: LLM; H1 e H2: pesquisadores correntes; HV: versao anterior de H2, fora
-- de `is_latest`, com as respostas que a arbitragem antiga escolheu.
INSERT INTO public.responses (id, project_id, document_id, respondent_id, respondent_type, is_latest, answers) VALUES
  ('b0c30000-0000-0000-0000-000000000001', 'b0c10000-0000-0000-0000-000000000001', 'b0c20000-0000-0000-0000-000000000001', NULL, 'llm', true,
   '{"s":"A","s4":"","s5":"Z","m":["B","A"],"g0":"Não","cm":[],"t":"Adalimumabe","s6":"A"}'),
  ('b0c30000-0000-0000-0000-000000000002', 'b0c10000-0000-0000-0000-000000000001', 'b0c20000-0000-0000-0000-000000000001', 'b0c00000-0000-0000-0000-000000000002', 'humano', true,
   '{"s":"A","s4":"","s5":"Z","m":["A","B"],"g0":"Não","t":"adalimumabé ","s6":"A"}'),
  ('b0c30000-0000-0000-0000-000000000003', 'b0c10000-0000-0000-0000-000000000001', 'b0c20000-0000-0000-0000-000000000001', 'b0c00000-0000-0000-0000-000000000003', 'humano', true,
   '{"s":" a","s4":"","s5":"Z","m":["B","A"],"g0":"Não","t":"ADA","s6":"A"}'),
  ('b0c30000-0000-0000-0000-000000000004', 'b0c10000-0000-0000-0000-000000000001', 'b0c20000-0000-0000-0000-000000000001', 'b0c00000-0000-0000-0000-000000000003', 'humano', false,
   '{"s":"B","s4":"A","s5":"A","m":["C"],"g0":"Sim","c":"A","cm":["A"],"t":"Outro remédio","s6":"B"}');

INSERT INTO public.reviews (id, project_id, document_id, field_name, reviewer_id, verdict, chosen_response_id)
SELECT ('b0c40000-0000-0000-0000-0000000000' || lpad(n::TEXT, 2, '0'))::UUID,
  'b0c10000-0000-0000-0000-000000000001', 'b0c20000-0000-0000-0000-000000000001', f, 'b0c00000-0000-0000-0000-000000000001', v,
  CASE WHEN f = 's6' THEN 'b0c30000-0000-0000-0000-000000000001'::UUID
       ELSE 'b0c30000-0000-0000-0000-000000000004'::UUID END
FROM (VALUES (1, 's', 'B'), (4, 's4', 'A'), (5, 's5', 'A'), (6, 'm', '{"C":true}'),
             (7, 'c', 'A'), (8, 'cm', '{"A":true}'), (9, 't', 'Outro remédio'), (12, 's6', 'B'))
  AS v(n, f, v);

-- Os contextos, abertos como o dono (creator) do projeto.
CREATE TEMP TABLE common_cases (field TEXT PRIMARY KEY, review UUID, context JSONB) ON COMMIT DROP;
INSERT INTO common_cases (field, review) VALUES
  ('s', 'b0c40000-0000-0000-0000-000000000001'),
  ('s4', 'b0c40000-0000-0000-0000-000000000004'),
  ('s5', 'b0c40000-0000-0000-0000-000000000005'),
  ('s6', 'b0c40000-0000-0000-0000-000000000012'),
  ('m', 'b0c40000-0000-0000-0000-000000000006'),
  ('c', 'b0c40000-0000-0000-0000-000000000007'),
  ('cm', 'b0c40000-0000-0000-0000-000000000008'),
  ('t', 'b0c40000-0000-0000-0000-000000000009');
GRANT ALL ON common_cases TO authenticated;

SELECT set_config('request.jwt.claims', '{"sub":"b0c00000-0000-0000-0000-000000000001","supabase_uid":"b0c00000-0000-0000-0000-000000000001"}', true);
SET LOCAL ROLE authenticated;
UPDATE common_cases SET context = public.llm_error_context(
  'b0c10000-0000-0000-0000-000000000001', 'b0c20000-0000-0000-0000-000000000001', field,
  'b0c30000-0000-0000-0000-000000000001', 'b0c30000-0000-0000-0000-000000000002', 'comparacao', review);
RESET ROLE;

-- (a) O RPC grava o valor comum que o contexto prova, e recusa o resto.
SELECT set_config('request.jwt.claims', '{"sub":"b0c00000-0000-0000-0000-000000000001","supabase_uid":"b0c00000-0000-0000-0000-000000000001"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  P CONSTANT UUID := 'b0c10000-0000-0000-0000-000000000001';
  D CONSTANT UUID := 'b0c20000-0000-0000-0000-000000000001';
  kase RECORD;
  item RECORD;
  v_state TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM common_cases WHERE context IS NULL) THEN RAISE EXCEPTION 'FALHOU: fixture sem contexto'; END IF;

  -- Aceitos: a resposta do LLM, o branco canonico de condicional com o LLM em
  -- branco, e a decisao sem valor quando nao ha valor comum.
  FOR kase IN SELECT * FROM (VALUES
      ('s', '"A"'::JSONB),
      ('m', '["B","A"]'::JSONB),
      ('c', '""'::JSONB),
      ('cm', '[]'::JSONB),
      ('t', '"Adalimumabe"'::JSONB),
      ('s', NULL::JSONB)) AS v(field, value) LOOP
    PERFORM public.set_error_resolution(P, D, kase.field, 'both_correct',
      (SELECT context FROM common_cases WHERE field = kase.field), NULL, NULL, 'Conferido', kase.value);
    SELECT * INTO item FROM public.read_error_resolutions(P) AS r WHERE r.field_name = kase.field;
    IF item.decision IS DISTINCT FROM 'both_correct' OR item.approved_value IS DISTINCT FROM kase.value THEN
      RAISE EXCEPTION 'FALHOU: "Ambos corretos" em % gravou % (esperado %)', kase.field, item.approved_value, kase.value;
    END IF;
    IF item.current_context IS DISTINCT FROM item.context THEN
      RAISE EXCEPTION 'FALHOU: decisão recém-gravada em % já nasce stale', kase.field;
    END IF;
    PERFORM public.set_error_resolution(P, D, kase.field, NULL, NULL, item.id, item.resolved_at);
  END LOOP;

  -- Recusados, cada um pela guarda que o descreve (SQLSTATE esperado).
  FOR kase IN SELECT * FROM (VALUES
      ('s', '"B"'::JSONB, '40001', 'valor que não é a resposta do LLM'),
      ('s', '" a"'::JSONB, '40001', 'a resposta de um pesquisador com outro texto'),
      ('t', '"ADA"'::JSONB, '40001', 'o texto do pesquisador ligado ao LLM por par "="'),
      ('c', '"A"'::JSONB, '40001', 'valor preenchido com o LLM em branco'),
      ('cm', '""'::JSONB, '40001', 'branco que não é o canônico do tipo'),
      ('s4', '""'::JSONB, '22023', 'branco fora de pergunta condicional'),
      ('s5', '"Z"'::JSONB, '22023', 'resposta do LLM fora do domínio da pergunta'),
      ('s6', '"A"'::JSONB, '22023', 'arbitragem que escolheu a própria resposta do LLM')
    ) AS v(field, value, expected_state, label) LOOP
    v_state := NULL;
    BEGIN
      PERFORM public.set_error_resolution(P, D, kase.field, 'both_correct',
        (SELECT context FROM common_cases WHERE field = kase.field), NULL, NULL, NULL, kase.value);
    EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE;
    END;
    IF v_state IS DISTINCT FROM kase.expected_state THEN
      RAISE EXCEPTION 'FALHOU: "Ambos corretos" com % (%: %) terminou em % (esperado %)',
        kase.label, kase.field, kase.value, COALESCE(v_state, 'gravação'), kase.expected_state;
    END IF;
  END LOOP;

  -- Sem valor comum, "Ambos corretos" com o LLM ausente nao tem o que
  -- declarar correto.
  BEGIN
    PERFORM public.set_error_resolution(P, D, 'c', 'both_correct', (SELECT context FROM common_cases WHERE field = 'c'), NULL, NULL, NULL, NULL);
    RAISE EXCEPTION 'FALHOU: "Ambos corretos" sem resposta do LLM e sem branco comum foi aceito';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  RAISE NOTICE 'OK: "Ambos corretos" grava o valor comum que o contexto prova e recusa o resto';
END $$;
RESET ROLE;

-- (b) A decisao com valor proprio nao depende da fonte: com a pergunta
-- mudada, o contexto calculado depois da mudanca segue valendo para ela, e
-- cai para a que nao tem valor. Mesmo desenho de reviews_field_hash.test.sql (e).
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

-- (c) CHECK: "Ambos corretos" aceita valor; as decisoes sem valor seguem sem.
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

-- (d) Grants: a validacao de dominio e interna ao RPC.
DO $$
BEGIN
  IF has_function_privilege('authenticated', 'public.error_resolution_value_problem(jsonb,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.error_resolution_value_problem(jsonb,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FALHOU: error_resolution_value_problem exposta ao cliente';
  END IF;
  RAISE NOTICE 'OK: grants';
END $$;

ROLLBACK;
