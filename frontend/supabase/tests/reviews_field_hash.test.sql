-- Contrato de `reviews.field_hash`: o veredito vale enquanto a pergunta nao muda.
--
-- Um veredito e sobre a resposta certa de um documento para uma pergunta. Ele
-- vale enquanto (1) o campo existe no schema atual, (2) o hash gravado no
-- veredito e o hash atual do campo, ou o hash gravado e NULL (legado sem como
-- provar) e (3) o valor do veredito esta no dominio atual do campo. A rodada
-- nao entra na regra, e editar a resposta depois nao invalida o veredito.
--
-- Blocos:
--   (a) catalogo: coluna, gatilhos, grants;
--   (b) matriz da funcao pura `review_verdict_valid`, a mesma regra de
--       `frontend/src/lib/review-validity.ts` (os casos espelham os do teste
--       unitario de la, para que as duas copias falhem juntas);
--   (c) carimbo pelo gatilho: INSERT e UPDATE OF verdict/chosen_response_id
--       carimbam o hash atual, manutencao nao carimba, cliente nao forja;
--   (d) `review_inferred_field_hash`, a regra do backfill: resposta escolhida,
--       senao respostas do snapshot que concordam, senao NULL;
--   (e) `llm_error_context` recusa abrir decisao ancorada em veredito
--       invalido, e `read_error_resolutions` so derruba a decisao gravada que
--       depende da fonte ("Ambos corretos", "Em discussao"); decisao que grava
--       valor proprio continua valendo.
--
-- Roda numa transacao e nao deixa fixture no banco local.

BEGIN;

-- (a) Catalogo. Vem primeiro para que a ausencia da coluna produza uma
-- mensagem legivel em vez do 42703 cru que os blocos seguintes levantariam.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.reviews'::regclass
      AND attribute.attname = 'field_hash'
      AND attribute.atttypid = 'text'::regtype
      AND NOT attribute.attnotnull
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION 'FALHOU: reviews.field_hash nao existe como text NULL';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    JOIN pg_catalog.pg_proc AS proc ON proc.oid = trigger_row.tgfoid
    WHERE trigger_row.tgrelid = 'public.reviews'::regclass
      AND NOT trigger_row.tgisinternal
      AND proc.proname IN ('stamp_review_field_hash', 'enforce_review_field_hash_immutable')
  ) <> 2 THEN
    RAISE EXCEPTION 'FALHOU: reviews nao tem os dois gatilhos de field_hash';
  END IF;

  IF has_function_privilege('anon', 'public.stamp_review_field_hash()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.stamp_review_field_hash()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.stamp_review_field_hash()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.enforce_review_field_hash_immutable()', 'EXECUTE') THEN
    RAISE EXCEPTION 'FALHOU: funcao de trigger de field_hash executavel por cliente';
  END IF;

  -- `review_is_valid` e SECURITY DEFINER e le qualquer review por id: so o
  -- service_role (invariantes) a chama de fora.
  IF has_function_privilege('anon', 'public.review_is_valid(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.review_is_valid(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.review_is_valid(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FALHOU: grants de review_is_valid';
  END IF;

  RAISE NOTICE 'OK: catalogo tem field_hash, gatilhos fechados e review_is_valid so para service_role';
END;
$$;

-- (b) Matriz da regra, sobre definicoes de campo em JSON. Cada linha e um caso
-- com o resultado esperado; a mensagem nomeia o caso que quebrou.
DO $$
DECLARE
  single_field CONSTANT JSONB := '{"name":"q","type":"single","options":["Sim","Não "],"description":"P","hash":"aaaaaaaaaaaa"}';
  single_other CONSTANT JSONB := '{"name":"q","type":"single","options":["Sim","Não"],"allow_other":true,"description":"P","hash":"aaaaaaaaaaaa"}';
  multi_field CONSTANT JSONB := '{"name":"m","type":"multi","options":["A","B"],"description":"P","hash":"bbbbbbbbbbbb"}';
  multi_other CONSTANT JSONB := '{"name":"m","type":"multi","options":["A","B"],"allow_other":true,"description":"P","hash":"bbbbbbbbbbbb"}';
  text_field CONSTANT JSONB := '{"name":"t","type":"text","description":"P","hash":"cccccccccccc"}';
  date_field CONSTANT JSONB := '{"name":"d","type":"date","description":"P","hash":"dddddddddddd"}';
  legacy_field CONSTANT JSONB := '{"name":"l","type":"single","options":["Sim"],"description":"P"}';
  item RECORD;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('pergunta identica', 'Sim', 'aaaaaaaaaaaa', single_field, true),
      ('texto com espaco e trim', '  Não', 'aaaaaaaaaaaa', single_field, true),
      ('pergunta alterada', 'Sim', 'ffffffffffff', single_field, false),
      ('campo removido', 'Sim', 'aaaaaaaaaaaa', NULL, false),
      ('hash NULL no dominio', 'Sim', NULL, single_field, true),
      ('hash NULL com single renomeado', 'Talvez', NULL, single_field, false),
      ('hash igual e valor fora do dominio', 'Talvez', 'aaaaaaaaaaaa', single_field, false),
      ('single com allow_other', 'Outro: quase', 'aaaaaaaaaaaa', single_other, true),
      ('ambiguo', 'ambiguo', 'aaaaaaaaaaaa', single_field, true),
      ('pular', 'pular', NULL, single_field, true),
      ('ambiguo com pergunta alterada', 'ambiguo', 'ffffffffffff', single_field, false),
      ('veredito em branco', '', 'aaaaaaaaaaaa', single_field, true),
      ('multi JSON nas opcoes', '{"A":true,"B":false}', 'bbbbbbbbbbbb', multi_field, true),
      ('multi com opcao extinta', '{"A":true,"C":true}', NULL, multi_field, false),
      ('multi com opcao extinta desmarcada', '{"A":true,"C":false}', NULL, multi_field, true),
      ('multi com allow_other', '{"A":true,"Outro: x":true}', 'bbbbbbbbbbbb', multi_other, true),
      ('multi votado em card', 'A, B', NULL, multi_field, true),
      ('multi votado em card com opcao extinta', 'A, C', NULL, multi_field, false),
      ('texto sempre no dominio', 'qualquer coisa', 'cccccccccccc', text_field, true),
      ('data sempre no dominio', '01/02/2020', 'dddddddddddd', date_field, true),
      ('campo sem hash e veredito com hash', 'Sim', 'aaaaaaaaaaaa', legacy_field, false),
      ('campo sem hash e veredito sem hash', 'Sim', NULL, legacy_field, true)
    ) AS matrix(label, verdict, field_hash, field, expected)
  LOOP
    IF public.review_verdict_valid(item.verdict, item.field_hash, item.field) IS DISTINCT FROM item.expected THEN
      RAISE EXCEPTION 'FALHOU: caso "%" deveria dar %', item.label, item.expected;
    END IF;
  END LOOP;
  RAISE NOTICE 'OK: matriz de validade do veredito';
END;
$$;

INSERT INTO auth.users (id, email) VALUES
  ('5e000000-0000-0000-0000-000000000001', 'field-hash-owner@example.test'),
  ('5e000000-0000-0000-0000-000000000002', 'field-hash-reviewer@example.test');
INSERT INTO public.clerk_user_mapping (clerk_user_id, supabase_user_id, access_sync_version)
  SELECT id::TEXT, id, 1 FROM auth.users WHERE id::TEXT LIKE '5e000000-%';

INSERT INTO public.projects (id, name, created_by, automation_mode, pydantic_fields) VALUES
  ('5e100000-0000-0000-0000-000000000001', 'veredito vale pela pergunta',
   '5e000000-0000-0000-0000-000000000001', 'compare_llm',
   '[{"id":"5ef00000-0000-4000-8000-000000000001","name":"q","type":"single","options":["Sim","Não"],"description":"Pergunta","hash":"aaaaaaaaaaaa"},
     {"id":"5ef00000-0000-4000-8000-000000000002","name":"t","type":"text","description":"Livre","hash":"cccccccccccc"},
     {"id":"5ef00000-0000-4000-8000-000000000003","name":"semhash","type":"text","description":"Legado"}]');

INSERT INTO public.documents (id, project_id, title, text) VALUES
  ('5e200000-0000-0000-0000-000000000001', '5e100000-0000-0000-0000-000000000001', 'Doc 1', 'Texto'),
  ('5e200000-0000-0000-0000-000000000002', '5e100000-0000-0000-0000-000000000001', 'Doc 2', 'Texto'),
  ('5e200000-0000-0000-0000-000000000003', '5e100000-0000-0000-0000-000000000001', 'Doc 3', 'Texto'),
  ('5e200000-0000-0000-0000-000000000004', '5e100000-0000-0000-0000-000000000001', 'Doc 4', 'Texto');

-- Um LLM (…01..04) e um humano (…11..14) por documento, na rodada corrente.
INSERT INTO public.responses (id, project_id, document_id, respondent_id, respondent_type, answers, answer_field_hashes)
SELECT
  ('5e300000-0000-0000-0000-0000000000' || lpad(n::TEXT, 2, '0'))::UUID,
  '5e100000-0000-0000-0000-000000000001',
  ('5e200000-0000-0000-0000-00000000000' || n)::UUID,
  NULL, 'llm', '{"q":"Sim","t":"LLM"}', '{"q":"aaaaaaaaaaaa","t":"cccccccccccc"}'
FROM generate_series(1, 4) AS n;
INSERT INTO public.responses (id, project_id, document_id, respondent_id, respondent_type, answers, answer_field_hashes)
SELECT
  ('5e300000-0000-0000-0000-0000000000' || (10 + n)::TEXT)::UUID,
  '5e100000-0000-0000-0000-000000000001',
  ('5e200000-0000-0000-0000-00000000000' || n)::UUID,
  '5e000000-0000-0000-0000-000000000002', 'humano', '{"q":"Não","t":"Humano"}', '{"q":"aaaaaaaaaaaa","t":"cccccccccccc"}'
FROM generate_series(1, 4) AS n;

-- (c) Carimbo. Replay do upsert de `submitVerdict`: o payload nao traz
-- `field_hash`, e um valor forjado pelo cliente e sobrescrito no INSERT.
INSERT INTO public.reviews (id, project_id, document_id, field_name, reviewer_id, verdict, chosen_response_id, field_hash) VALUES
  ('5e400000-0000-0000-0000-000000000001', '5e100000-0000-0000-0000-000000000001', '5e200000-0000-0000-0000-000000000001',
   'q', '5e000000-0000-0000-0000-000000000002', 'Não', '5e300000-0000-0000-0000-000000000011', 'forjado00000'),
  ('5e400000-0000-0000-0000-000000000002', '5e100000-0000-0000-0000-000000000001', '5e200000-0000-0000-0000-000000000001',
   'semhash', '5e000000-0000-0000-0000-000000000002', 'x', NULL, NULL),
  ('5e400000-0000-0000-0000-000000000003', '5e100000-0000-0000-0000-000000000001', '5e200000-0000-0000-0000-000000000001',
   'sumiu', '5e000000-0000-0000-0000-000000000002', 'x', NULL, NULL);

DO $$
BEGIN
  IF (SELECT field_hash FROM public.reviews WHERE id = '5e400000-0000-0000-0000-000000000001') IS DISTINCT FROM 'aaaaaaaaaaaa' THEN
    RAISE EXCEPTION 'FALHOU: INSERT nao carimbou o hash atual do campo (ou aceitou o do cliente)';
  END IF;
  IF (SELECT field_hash FROM public.reviews WHERE id = '5e400000-0000-0000-0000-000000000002') IS NOT NULL
     OR (SELECT field_hash FROM public.reviews WHERE id = '5e400000-0000-0000-0000-000000000003') IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU: campo sem hash ou fora do schema deveria carimbar NULL';
  END IF;
  IF NOT public.review_is_valid('5e400000-0000-0000-0000-000000000001')
     OR NOT public.review_is_valid('5e400000-0000-0000-0000-000000000002')
     OR public.review_is_valid('5e400000-0000-0000-0000-000000000003')
     OR public.review_is_valid('5e4fffff-0000-0000-0000-000000000000') THEN
    RAISE EXCEPTION 'FALHOU: review_is_valid logo apos o carimbo';
  END IF;
  RAISE NOTICE 'OK: INSERT carimba o hash atual, NULL sem hash, e o cliente nao forja';
END;
$$;

-- A pergunta muda (descricao nova, hash novo).
UPDATE public.projects
SET pydantic_fields = jsonb_set(pydantic_fields, '{0}',
      pydantic_fields->0 || '{"description":"Pergunta reescrita","hash":"eeeeeeeeeeee"}'),
    schema_revision = schema_revision + 1
WHERE id = '5e100000-0000-0000-0000-000000000001';

-- Editar a resposta escolhida depois da arbitragem nao muda o veredito.
UPDATE public.responses SET answers = '{"q":"Sim","t":"Humano"}' WHERE id = '5e300000-0000-0000-0000-000000000011';

-- Manutencao (resolucao e comentario) nao recarimba: o veredito continua
-- sendo sobre a pergunta antiga.
UPDATE public.reviews SET resolved_at = now(), comment = 'nota'
WHERE id = '5e400000-0000-0000-0000-000000000001';

DO $$
BEGIN
  IF (SELECT field_hash FROM public.reviews WHERE id = '5e400000-0000-0000-0000-000000000001') IS DISTINCT FROM 'aaaaaaaaaaaa' THEN
    RAISE EXCEPTION 'FALHOU: update de manutencao recarimbou o hash';
  END IF;
  IF public.review_is_valid('5e400000-0000-0000-0000-000000000001') THEN
    RAISE EXCEPTION 'FALHOU: veredito sobre a pergunta antiga continua valido';
  END IF;
  RAISE NOTICE 'OK: pergunta alterada invalida o veredito, e manutencao nao o revalida';
END;
$$;

-- Cliente nao move o hash: reescrever `field_hash` para o atual ressuscitaria
-- um veredito dado sobre outra pergunta sem rearbitragem.
DO $$
BEGIN
  BEGIN
    UPDATE public.reviews SET field_hash = 'eeeeeeeeeeee' WHERE id = '5e400000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'FALHOU: UPDATE direto de field_hash foi aceito';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'OK: field_hash imutavel para o cliente';
END;
$$;

-- Rearbitrar com payload identico recarimba: a trigger dispara pela coluna no
-- SET, como o upsert do PostgREST manda.
UPDATE public.reviews SET verdict = 'Não', chosen_response_id = '5e300000-0000-0000-0000-000000000011'
WHERE id = '5e400000-0000-0000-0000-000000000001';

DO $$
BEGIN
  IF (SELECT field_hash FROM public.reviews WHERE id = '5e400000-0000-0000-0000-000000000001') IS DISTINCT FROM 'eeeeeeeeeeee'
     OR NOT public.review_is_valid('5e400000-0000-0000-0000-000000000001') THEN
    RAISE EXCEPTION 'FALHOU: rearbitragem nao recarimbou o hash atual';
  END IF;
  RAISE NOTICE 'OK: rearbitragem recarimba e revalida';
END;
$$;

-- (d) Regra do backfill.
INSERT INTO public.responses (id, project_id, document_id, respondent_id, respondent_type, answers, answer_field_hashes) VALUES
  ('5e300000-0000-0000-0000-000000000021', '5e100000-0000-0000-0000-000000000001', '5e200000-0000-0000-0000-000000000002',
   '5e000000-0000-0000-0000-000000000001', 'humano', '{"t":"a"}', '{"t":"111111111111"}'),
  ('5e300000-0000-0000-0000-000000000022', '5e100000-0000-0000-0000-000000000001', '5e200000-0000-0000-0000-000000000003',
   '5e000000-0000-0000-0000-000000000001', 'humano', '{"t":"a"}', '{}');
INSERT INTO public.reviews (id, project_id, document_id, field_name, reviewer_id, verdict, chosen_response_id, response_snapshot) VALUES
  -- escolhida com hash: vence o snapshot
  ('5e400000-0000-0000-0000-000000000011', '5e100000-0000-0000-0000-000000000001', '5e200000-0000-0000-0000-000000000002',
   't', '5e000000-0000-0000-0000-000000000001', 'a', '5e300000-0000-0000-0000-000000000021',
   '[{"id":"5e300000-0000-0000-0000-000000000002"},{"id":"5e300000-0000-0000-0000-000000000012"}]'),
  -- sem escolha; snapshot concorda
  ('5e400000-0000-0000-0000-000000000012', '5e100000-0000-0000-0000-000000000001', '5e200000-0000-0000-0000-000000000002',
   't', '5e000000-0000-0000-0000-000000000002', 'ambiguo', NULL,
   '[{"id":"5e300000-0000-0000-0000-000000000002"},{"id":"5e300000-0000-0000-0000-000000000012"}]'),
  -- escolhida sem hash (legado {}); snapshot com uma resposta sem hash: NULL
  ('5e400000-0000-0000-0000-000000000013', '5e100000-0000-0000-0000-000000000001', '5e200000-0000-0000-0000-000000000003',
   't', '5e000000-0000-0000-0000-000000000001', 'a', '5e300000-0000-0000-0000-000000000022',
   '[{"id":"5e300000-0000-0000-0000-000000000003"},{"id":"5e300000-0000-0000-0000-000000000022"}]'),
  -- escolhida sem hash; snapshot concorda: hash do snapshot
  ('5e400000-0000-0000-0000-000000000014', '5e100000-0000-0000-0000-000000000001', '5e200000-0000-0000-0000-000000000003',
   't', '5e000000-0000-0000-0000-000000000002', 'a', '5e300000-0000-0000-0000-000000000022',
   '[{"id":"5e300000-0000-0000-0000-000000000003"},{"id":"5e300000-0000-0000-0000-000000000013"}]');
-- Snapshot que discorda: o LLM do doc 4 passa a ter outro hash em `t`.
UPDATE public.responses SET answer_field_hashes = '{"q":"aaaaaaaaaaaa","t":"222222222222"}'
WHERE id = '5e300000-0000-0000-0000-000000000004';
INSERT INTO public.reviews (id, project_id, document_id, field_name, reviewer_id, verdict, chosen_response_id, response_snapshot) VALUES
  ('5e400000-0000-0000-0000-000000000015', '5e100000-0000-0000-0000-000000000001', '5e200000-0000-0000-0000-000000000004',
   't', '5e000000-0000-0000-0000-000000000001', 'a', NULL,
   '[{"id":"5e300000-0000-0000-0000-000000000004"},{"id":"5e300000-0000-0000-0000-000000000014"}]');

DO $$
BEGIN
  IF public.review_inferred_field_hash('5e400000-0000-0000-0000-000000000011') IS DISTINCT FROM '111111111111' THEN
    RAISE EXCEPTION 'FALHOU: backfill deveria usar o hash da resposta escolhida';
  END IF;
  IF public.review_inferred_field_hash('5e400000-0000-0000-0000-000000000012') IS DISTINCT FROM 'cccccccccccc' THEN
    RAISE EXCEPTION 'FALHOU: backfill deveria usar o hash em que o snapshot concorda';
  END IF;
  IF public.review_inferred_field_hash('5e400000-0000-0000-0000-000000000013') IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU: snapshot com resposta sem hash nao prova a pergunta';
  END IF;
  IF public.review_inferred_field_hash('5e400000-0000-0000-0000-000000000014') IS DISTINCT FROM 'cccccccccccc' THEN
    RAISE EXCEPTION 'FALHOU: escolhida sem hash deveria cair no snapshot';
  END IF;
  IF public.review_inferred_field_hash('5e400000-0000-0000-0000-000000000015') IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU: snapshot que discorda nao prova a pergunta';
  END IF;
  RAISE NOTICE 'OK: regra do backfill (escolhida, snapshot concordante, NULL)';
END;
$$;

-- (e) Decisao do LLM Insights ancorada em veredito invalido. Uma review por
-- documento em `t`; depois a pergunta `t` muda. O contexto e calculado DEPOIS
-- da mudanca, entao `field_definition` confere com o schema atual e o unico
-- motivo para a decisao cair e a fonte.
DELETE FROM public.reviews WHERE field_name = 't';
INSERT INTO public.reviews (id, project_id, document_id, field_name, reviewer_id, verdict, chosen_response_id)
SELECT
  ('5e400000-0000-0000-0000-00000000002' || n)::UUID,
  '5e100000-0000-0000-0000-000000000001',
  ('5e200000-0000-0000-0000-00000000000' || n)::UUID,
  't', '5e000000-0000-0000-0000-000000000002', 'Humano',
  ('5e300000-0000-0000-0000-0000000000' || (10 + n)::TEXT)::UUID
FROM generate_series(1, 4) AS n;

UPDATE public.projects
SET pydantic_fields = jsonb_set(pydantic_fields, '{1}',
      pydantic_fields->1 || '{"description":"Livre, reescrita","hash":"999999999999"}'),
    schema_revision = schema_revision + 1
WHERE id = '5e100000-0000-0000-0000-000000000001';

CREATE TEMP TABLE field_hash_contexts (n INT PRIMARY KEY, guarded JSONB, opened JSONB) ON COMMIT DROP;
GRANT ALL ON field_hash_contexts TO authenticated;

SELECT set_config('request.jwt.claims', '{"sub":"5e000000-0000-0000-0000-000000000001","supabase_uid":"5e000000-0000-0000-0000-000000000001"}', true);
SET LOCAL ROLE authenticated;
INSERT INTO field_hash_contexts (n, guarded, opened)
SELECT n,
  public.llm_error_context('5e100000-0000-0000-0000-000000000001', ('5e200000-0000-0000-0000-00000000000' || n)::UUID, 't',
    ('5e300000-0000-0000-0000-0000000000' || lpad(n::TEXT, 2, '0'))::UUID,
    ('5e300000-0000-0000-0000-0000000000' || (10 + n)::TEXT)::UUID,
    'comparacao', ('5e400000-0000-0000-0000-00000000002' || n)::UUID),
  public.llm_error_context('5e100000-0000-0000-0000-000000000001', ('5e200000-0000-0000-0000-00000000000' || n)::UUID, 't',
    ('5e300000-0000-0000-0000-0000000000' || lpad(n::TEXT, 2, '0'))::UUID,
    ('5e300000-0000-0000-0000-0000000000' || (10 + n)::TEXT)::UUID,
    'comparacao', ('5e400000-0000-0000-0000-00000000002' || n)::UUID, false)
FROM generate_series(1, 4) AS n;
RESET ROLE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM field_hash_contexts WHERE guarded IS NOT NULL) THEN
    RAISE EXCEPTION 'FALHOU: llm_error_context abriu decisao sobre veredito da pergunta antiga';
  END IF;
  IF EXISTS (SELECT 1 FROM field_hash_contexts WHERE opened IS NULL) THEN
    RAISE EXCEPTION 'FALHOU: sem a guarda o contexto deveria existir (fixture quebrada)';
  END IF;
  RAISE NOTICE 'OK: llm_error_context recusa abrir decisao sobre veredito invalido';
END;
$$;

-- Decisoes gravadas antes desta regra (o caso de producao): uma de cada tipo.
INSERT INTO public.error_resolutions (project_id, document_id, field_name, decision, context, approved_value, resolved_by, note)
SELECT '5e100000-0000-0000-0000-000000000001', ('5e200000-0000-0000-0000-00000000000' || n)::UUID, 't',
  (ARRAY['both_correct', 'discussion', 'llm_correct', 'researchers_correct'])[n],
  opened,
  CASE WHEN n = 4 THEN '"Valor novo"'::JSONB END,
  '5e000000-0000-0000-0000-000000000001', NULL
FROM field_hash_contexts;

SET LOCAL ROLE authenticated;
DO $$
DECLARE
  item RECORD;
BEGIN
  FOR item IN
    SELECT resolution.decision, resolution.context, resolution.current_context
    FROM public.read_error_resolutions('5e100000-0000-0000-0000-000000000001') AS resolution
    WHERE resolution.field_name = 't'
  LOOP
    IF item.decision IN ('both_correct', 'discussion') AND item.current_context IS NOT NULL THEN
      RAISE EXCEPTION 'FALHOU: decisao "%" continua valendo com a fonte invalida', item.decision;
    END IF;
    IF item.decision IN ('llm_correct', 'researchers_correct') AND item.current_context IS DISTINCT FROM item.context THEN
      RAISE EXCEPTION 'FALHOU: decisao "%" grava valor proprio e nao deveria cair com a fonte', item.decision;
    END IF;
  END LOOP;

  -- Redecidir e decisao nova: recusada enquanto a fonte for invalida.
  SELECT * INTO item FROM public.error_resolutions
  WHERE document_id = '5e200000-0000-0000-0000-000000000003' AND field_name = 't';
  BEGIN
    PERFORM public.set_error_resolution('5e100000-0000-0000-0000-000000000001', '5e200000-0000-0000-0000-000000000003', 't',
      'llm_correct', item.context, item.id, item.resolved_at);
    RAISE EXCEPTION 'FALHOU: decisao nova aceita sobre veredito invalido';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
  RAISE NOTICE 'OK: so as decisoes que dependem da fonte caem, e decisao nova e recusada';
END;
$$;
RESET ROLE;

-- Rearbitrar a celula revalida a fonte: a decisao "Ambos corretos" volta a valer.
UPDATE public.reviews SET verdict = 'Humano' WHERE id = '5e400000-0000-0000-0000-000000000021';

SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.read_error_resolutions('5e100000-0000-0000-0000-000000000001') AS resolution
    WHERE resolution.field_name = 't' AND resolution.decision = 'both_correct'
      AND resolution.current_context = resolution.context
  ) THEN
    RAISE EXCEPTION 'FALHOU: rearbitragem nao revalidou a decisao que depende da fonte';
  END IF;
  RAISE NOTICE 'OK: rearbitragem revalida a decisao';
END;
$$;
RESET ROLE;

ROLLBACK;
