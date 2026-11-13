-- Contrato da migration 20261112120000_self_comparison_exception: o codificador
-- do documento continua sem receber a comparação dele (regra de
-- 20260716160100), salvo quando o coordenador libera a autocomparação naquela
-- atribuição. A liberação é carimbada pelo banco (quem e quando) e não pode
-- ser concedida pelo próprio pesquisador.
--
-- Cenário: C coordena (e criou) o projeto; M codificou D1 e é a única
-- pesquisadora; R é pesquisador sem papel de coordenação.
--
-- Como rodar (após `npx supabase start` e `npx supabase db reset`):
--   bash scripts/run-sql-test.sh supabase/tests/self_comparison_exception.test.sql
--
-- Validar pelo exit code. Roda inteiro em BEGIN ... ROLLBACK.

BEGIN;

-- ========== Fixtures ==========
INSERT INTO auth.users (id, email) VALUES
  ('5c000000-0000-0000-0000-00000000000c', 'coord-self-compare@example.test'),
  ('5c000000-0000-0000-0000-00000000000a', 'coder-self-compare@example.test'),
  ('5c000000-0000-0000-0000-00000000000b', 'other-self-compare@example.test');

INSERT INTO public.clerk_user_mapping
  (clerk_user_id, supabase_user_id, access_sync_version)
SELECT id::text, id, 1
FROM auth.users
WHERE id::text LIKE '5c000000-0000-0000-0000-%';

INSERT INTO public.projects (id, name, created_by, pydantic_fields) VALUES
  ('5c100000-0000-0000-0000-000000000001', 'autocomparação',
   '5c000000-0000-0000-0000-00000000000c',
   '[{"id":"00000000-0000-4000-8000-00000000c0a1","name":"q1"}]');

INSERT INTO public.documents (id, project_id, title, text, text_hash) VALUES
  ('5c200000-0000-0000-0000-000000000001',
   '5c100000-0000-0000-0000-000000000001', 'D1', 'texto 1', 'h-self-1'),
  ('5c200000-0000-0000-0000-000000000002',
   '5c100000-0000-0000-0000-000000000001', 'D2', 'texto 2', 'h-self-2');

INSERT INTO public.project_members (project_id, user_id, role, can_compare)
VALUES
  ('5c100000-0000-0000-0000-000000000001',
   '5c000000-0000-0000-0000-00000000000c', 'coordenador', true),
  ('5c100000-0000-0000-0000-000000000001',
   '5c000000-0000-0000-0000-00000000000a', 'pesquisador', true),
  ('5c100000-0000-0000-0000-000000000001',
   '5c000000-0000-0000-0000-00000000000b', 'pesquisador', true);

INSERT INTO public.responses
  (id, project_id, document_id, respondent_id, respondent_type, answers)
VALUES
  ('5c300000-0000-0000-0000-000000000001', '5c100000-0000-0000-0000-000000000001',
   '5c200000-0000-0000-0000-000000000001', '5c000000-0000-0000-0000-00000000000a',
   'humano', '{"q1":"a"}'),
  ('5c300000-0000-0000-0000-000000000002', '5c100000-0000-0000-0000-000000000001',
   '5c200000-0000-0000-0000-000000000001', NULL,
   'llm', '{"q1":"b"}');

-- Em produção o role `authenticated` tem DML nestas tabelas (o app opera via
-- PostgREST autenticado); o supabase local não concede por padrão.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.assignments, public.responses
  TO authenticated;

-- ========== 1. Padrão: sem liberação, a regra antiga continua ==========
DO $$
BEGIN
  INSERT INTO public.assignments (project_id, document_id, user_id, type, status)
  VALUES ('5c100000-0000-0000-0000-000000000001', '5c200000-0000-0000-0000-000000000001',
          '5c000000-0000-0000-0000-00000000000a', 'comparacao', 'pendente');
  RAISE EXCEPTION 'FALHOU 1: comparação do próprio codificador entrou sem liberação';
EXCEPTION
  WHEN check_violation THEN
    RAISE NOTICE 'OK 1: sem liberação, 23514 como antes';
END;
$$;

-- O sorteio automático não muda: a RPC continua recusando o codificador.
DO $$
BEGIN
  IF public.assign_comparison_if_eligible(
    '5c100000-0000-0000-0000-000000000001',
    '5c200000-0000-0000-0000-000000000001',
    '5c000000-0000-0000-0000-00000000000a'
  ) THEN
    RAISE EXCEPTION 'FALHOU 1b: a RPC do sorteio automático atribuiu ao codificador';
  END IF;
  RAISE NOTICE 'OK 1b: sorteio automático segue excluindo o codificador';
END;
$$;

-- ========== 2. A liberação só existe em comparação ==========
DO $$
BEGIN
  INSERT INTO public.assignments
    (project_id, document_id, user_id, type, status, self_comparison_approved_by)
  VALUES ('5c100000-0000-0000-0000-000000000001', '5c200000-0000-0000-0000-000000000002',
          '5c000000-0000-0000-0000-00000000000b', 'codificacao', 'pendente',
          '5c000000-0000-0000-0000-00000000000c');
  RAISE EXCEPTION 'FALHOU 2: liberação aceita numa codificação';
EXCEPTION
  WHEN check_violation THEN
    RAISE NOTICE 'OK 2: liberação recusada fora de comparação';
END;
$$;

-- ========== 3. Sem sessão: a liberação precisa nomear um coordenador ==========
DO $$
BEGIN
  INSERT INTO public.assignments
    (project_id, document_id, user_id, type, status, self_comparison_approved_by)
  VALUES ('5c100000-0000-0000-0000-000000000001', '5c200000-0000-0000-0000-000000000001',
          '5c000000-0000-0000-0000-00000000000a', 'comparacao', 'pendente',
          '5c000000-0000-0000-0000-00000000000b');
  RAISE EXCEPTION 'FALHOU 3: liberação em nome de não-coordenador aceita';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 3: liberação em nome de não-coordenador recusada';
END;
$$;

-- Comparação legítima de M em D2 (ela não codificou D2), para o cenário 4.
INSERT INTO public.assignments (id, project_id, document_id, user_id, type, status)
VALUES ('5c400000-0000-0000-0000-000000000002', '5c100000-0000-0000-0000-000000000001',
        '5c200000-0000-0000-0000-000000000002', '5c000000-0000-0000-0000-00000000000a',
        'comparacao', 'pendente');

-- ========== 4. O pesquisador não se libera sozinho ==========
-- A policy "Researchers update own assignments" deixa M fazer UPDATE na
-- própria linha; o gatilho de guarda é quem barra.
SELECT set_config('request.jwt.claims',
  '{"sub":"5c000000-0000-0000-0000-00000000000a","supabase_uid":"5c000000-0000-0000-0000-00000000000a"}',
  true);
SET LOCAL ROLE authenticated;

DO $$
BEGIN
  UPDATE public.assignments
  SET self_comparison_approved_by = '5c000000-0000-0000-0000-00000000000a'
  WHERE id = '5c400000-0000-0000-0000-000000000002';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FALHOU 4: RLS escondeu a linha; o cenário não exercitou o gatilho';
  END IF;
  RAISE EXCEPTION 'FALHOU 4: pesquisador liberou a própria autocomparação';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 4: pesquisador não libera a própria autocomparação';
END;
$$;

-- Com a comparação de D2 aberta e sem liberação, M segue sem poder codificar
-- D2 (o lado das respostas da regra antiga).
DO $$
BEGIN
  INSERT INTO public.responses
    (project_id, document_id, respondent_id, respondent_type, answers)
  VALUES ('5c100000-0000-0000-0000-000000000001', '5c200000-0000-0000-0000-000000000002',
          '5c000000-0000-0000-0000-00000000000a', 'humano', '{"q1":"a"}');
  RAISE EXCEPTION 'FALHOU 4b: revisor sem liberação codificou o documento';
EXCEPTION
  WHEN check_violation THEN
    RAISE NOTICE 'OK 4b: revisor sem liberação segue sem codificar o documento';
END;
$$;

RESET ROLE;

-- ========== 5. O coordenador libera, e o banco carimba quem e quando ==========
SELECT set_config('request.jwt.claims',
  '{"sub":"5c000000-0000-0000-0000-00000000000c","supabase_uid":"5c000000-0000-0000-0000-00000000000c"}',
  true);
SET LOCAL ROLE authenticated;

-- O cliente manda um aprovador qualquer; vale o da sessão.
INSERT INTO public.assignments
  (id, project_id, document_id, user_id, type, status, self_comparison_approved_by)
VALUES ('5c400000-0000-0000-0000-000000000001', '5c100000-0000-0000-0000-000000000001',
        '5c200000-0000-0000-0000-000000000001', '5c000000-0000-0000-0000-00000000000a',
        'comparacao', 'pendente', '5c000000-0000-0000-0000-00000000000b');

RESET ROLE;

DO $$
DECLARE
  v_by uuid;
  v_at timestamptz;
BEGIN
  SELECT self_comparison_approved_by, self_comparison_approved_at
  INTO v_by, v_at
  FROM public.assignments
  WHERE id = '5c400000-0000-0000-0000-000000000001';
  IF v_by IS DISTINCT FROM '5c000000-0000-0000-0000-00000000000c' THEN
    RAISE EXCEPTION 'FALHOU 5: aprovador não é o da sessão (%)', v_by;
  END IF;
  IF v_at IS NULL THEN
    RAISE EXCEPTION 'FALHOU 5: liberação sem carimbo de horário';
  END IF;
  RAISE NOTICE 'OK 5: coordenador liberou e o banco carimbou quem e quando';
END;
$$;

-- ========== 6. Com liberação, M revisa a própria codificação ==========
-- O UPDATE OF respondent_id dispara enforce_comparison_response_actor mesmo
-- sem mudar o valor; com a comparação de D1 liberada ele passa.
UPDATE public.responses
SET respondent_id = respondent_id
WHERE id = '5c300000-0000-0000-0000-000000000001';

-- E M avança a própria atribuição (status), como no fluxo normal.
SELECT set_config('request.jwt.claims',
  '{"sub":"5c000000-0000-0000-0000-00000000000a","supabase_uid":"5c000000-0000-0000-0000-00000000000a"}',
  true);
SET LOCAL ROLE authenticated;
UPDATE public.assignments
SET status = 'em_andamento'
WHERE id = '5c400000-0000-0000-0000-000000000001';
RESET ROLE;

DO $$
BEGIN
  IF (SELECT status FROM public.assignments
      WHERE id = '5c400000-0000-0000-0000-000000000001') IS DISTINCT FROM 'em_andamento' THEN
    RAISE EXCEPTION 'FALHOU 6: a pesquisadora não avançou a comparação liberada';
  END IF;
  RAISE NOTICE 'OK 6: com liberação, a pesquisadora revisa e avança a comparação';
END;
$$;

-- ========== 7. Retirar a liberação de uma comparação aberta é recusado ==========
-- Sem sessão, para isolar a regra de autocomparação da guarda de autoria.
SELECT set_config('request.jwt.claims', '', true);

DO $$
BEGIN
  UPDATE public.assignments
  SET self_comparison_approved_by = NULL,
      self_comparison_approved_at = NULL
  WHERE id = '5c400000-0000-0000-0000-000000000001';
  RAISE EXCEPTION 'FALHOU 7: liberação retirada com a autocomparação aberta';
EXCEPTION
  WHEN check_violation THEN
    RAISE NOTICE 'OK 7: retirar a liberação de comparação aberta é recusado';
END;
$$;

-- ========== 8. A liberação não acompanha a linha para outro par ==========
-- M codificou também D2; a comparação liberada de D1 não pode virar uma
-- comparação "liberada" de D2 trocando o documento da linha.
DELETE FROM public.assignments WHERE id = '5c400000-0000-0000-0000-000000000002';
INSERT INTO public.responses
  (project_id, document_id, respondent_id, respondent_type, answers)
VALUES ('5c100000-0000-0000-0000-000000000001', '5c200000-0000-0000-0000-000000000002',
        '5c000000-0000-0000-0000-00000000000a', 'humano', '{"q1":"a"}');

SELECT set_config('request.jwt.claims',
  '{"sub":"5c000000-0000-0000-0000-00000000000a","supabase_uid":"5c000000-0000-0000-0000-00000000000a"}',
  true);
SET LOCAL ROLE authenticated;

DO $$
BEGIN
  UPDATE public.assignments
  SET document_id = '5c200000-0000-0000-0000-000000000002'
  WHERE id = '5c400000-0000-0000-0000-000000000001';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FALHOU 8: RLS escondeu a linha; o cenário não exercitou o gatilho';
  END IF;
  RAISE EXCEPTION 'FALHOU 8: a liberação de D1 foi levada para D2';
EXCEPTION
  WHEN check_violation THEN
    RAISE NOTICE 'OK 8: trocar o documento descarta a liberação e a regra volta a valer';
END;
$$;

RESET ROLE;

\echo 'self_comparison_exception: OK'

ROLLBACK;
