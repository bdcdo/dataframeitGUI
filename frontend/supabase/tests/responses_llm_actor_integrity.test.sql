-- Regressão: membro não pode plantar resposta "do LLM" com a própria autoria.
--
-- Como rodar após `npx supabase db reset`:
--   docker exec -i supabase_db_frontend psql -U postgres -d postgres \
--     -X -v ON_ERROR_STOP=1 < supabase/tests/responses_llm_actor_integrity.test.sql
-- Sucesso = nenhuma exceção e os NOTICE "OK ..." no final. Qualquer FALHOU aborta.
--
-- IMPORTANTE — por que este arquivo concede DML explicitamente: o Supabase
-- remoto concede INSERT/UPDATE/DELETE a `authenticated` no schema public por
-- default privileges, mas o ambiente local não. Um teste que apenas tentasse o
-- INSERT malicioso passaria aqui por falta de privilégio (42501) e continuaria
-- cego ao que produção permite. Os GRANTs abaixo replicam a superfície do
-- remoto para que a RLS e as constraints sejam de fato exercidas.

BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('11100000-0000-0000-0000-000000000001', 'coord@example.test'),
  ('11100000-0000-0000-0000-000000000002', 'pesquisador@example.test');

INSERT INTO public.clerk_user_mapping (clerk_user_id, supabase_user_id)
SELECT id::text, id
FROM auth.users
WHERE id::text LIKE '11100000-0000-0000-0000-%';

INSERT INTO public.projects (id, name, created_by) VALUES
  ('22200000-0000-0000-0000-000000000001', 'llm actor integrity',
   '11100000-0000-0000-0000-000000000001');

INSERT INTO public.documents (id, project_id, title, text, text_hash) VALUES
  ('33300000-0000-0000-0000-000000000001', '22200000-0000-0000-0000-000000000001',
   'doc', 'texto', 'h-doc');

INSERT INTO public.project_members (project_id, user_id, role) VALUES
  ('22200000-0000-0000-0000-000000000001',
   '11100000-0000-0000-0000-000000000002', 'pesquisador');

GRANT SELECT, INSERT, UPDATE, DELETE ON public.responses TO authenticated;

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"11100000-0000-0000-0000-000000000002",'
    || '"supabase_uid":"11100000-0000-0000-0000-000000000002"}',
  true
);
SET LOCAL ROLE authenticated;

-- ========== O braço LLM não aceita autor humano ==========
DO $$
BEGIN
  -- A policy autoriza pelo respondent_id, então este INSERT passa pela RLS: o
  -- pesquisador é dono da linha. Quem recusa é a constraint de schema — sem
  -- ela, esta resposta entraria como "a do LLM", idêntica à codificação
  -- humana, e o campo sairia como consenso sem nunca gerar field_review.
  BEGIN
    INSERT INTO public.responses
      (project_id, document_id, respondent_id, respondent_type, answers, is_latest)
    VALUES
      ('22200000-0000-0000-0000-000000000001',
       '33300000-0000-0000-0000-000000000001',
       '11100000-0000-0000-0000-000000000002',
       'llm', '{"q1":"forjado"}', true);
    RAISE EXCEPTION
      'FALHOU integridade: membro plantou resposta llm com a própria autoria';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'OK: resposta llm com autor humano recusada';
  END;
END;
$$;

-- ========== Sem autor, a policy é quem recusa ==========
DO $$
BEGIN
  -- Contornar a constraint zerando o respondent_id não ajuda: nenhum braço da
  -- policy cobre a linha (não é dele, e ele não é coordenador nem master).
  BEGIN
    INSERT INTO public.responses
      (project_id, document_id, respondent_id, respondent_type, answers, is_latest)
    VALUES
      ('22200000-0000-0000-0000-000000000001',
       '33300000-0000-0000-0000-000000000001',
       NULL, 'llm', '{"q1":"forjado"}', true);
    RAISE EXCEPTION
      'FALHOU integridade: membro plantou resposta llm anônima';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'OK: resposta llm sem autor recusada pela RLS';
  END;
END;
$$;

-- ========== A codificação humana legítima continua passando ==========
DO $$
DECLARE
  n INTEGER;
BEGIN
  INSERT INTO public.responses
    (project_id, document_id, respondent_id, respondent_type, answers, is_latest)
  VALUES
    ('22200000-0000-0000-0000-000000000001',
     '33300000-0000-0000-0000-000000000001',
     '11100000-0000-0000-0000-000000000002',
     'humano', '{"q1":"a"}', true);

  SELECT count(*) INTO n FROM public.responses
  WHERE project_id = '22200000-0000-0000-0000-000000000001'
    AND respondent_type = 'humano';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALHOU: codificação humana legítima foi bloqueada';
  END IF;

  RAISE NOTICE 'OK: codificação humana do próprio membro segue permitida';
END;
$$;

-- ========== O backend continua podendo gravar o braço LLM ==========
RESET ROLE;
SELECT set_config('request.jwt.claims', '', true);

DO $$
DECLARE
  n INTEGER;
BEGIN
  -- llm_runner grava sem respondent_id: é assim que a constraint distingue o
  -- LLM de uma pessoa.
  INSERT INTO public.responses
    (project_id, document_id, respondent_type, respondent_name, answers, is_latest)
  VALUES
    ('22200000-0000-0000-0000-000000000001',
     '33300000-0000-0000-0000-000000000001',
     'llm', 'openai/gpt-5', '{"q1":"b"}', true);

  SELECT count(*) INTO n FROM public.responses
  WHERE project_id = '22200000-0000-0000-0000-000000000001'
    AND respondent_type = 'llm';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALHOU: backend não conseguiu gravar a resposta do LLM';
  END IF;

  RAISE NOTICE 'OK: backend grava o braço llm sem respondent_id';
END;
$$;

ROLLBACK;
