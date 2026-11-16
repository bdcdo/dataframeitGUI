-- Contrato: ciclo superado não fica em `field_reviews`, e o assignment de
-- arbitragem que dependia dele não fica aberto.
--
-- Os fechos da arbitragem (`submit_final_review_verdicts`,
-- `sync_arbitration_assignment_status`) e as limpezas dos gatilhos de arquivo
-- decidem "resta campo pendente para este árbitro" por `final_verdict IS NULL`,
-- sem olhar `superseded_at`. A 20260724110000 registra que isso é escolha: na
-- tabela operacional o campo contestado superado é inconstruível, e o filtro
-- seria guarda morta. A fila do app filtra `superseded_at IS NULL`
-- (`pendingArbitrationFieldsQuery`), então as duas regras só coincidem
-- enquanto essa premissa valer. Este contrato fixa a premissa, pelos dois
-- únicos caminhos que poderiam quebrá-la:
--
--   1. o reconciliador, único produtor de `superseded_at` na tabela
--      operacional (o INSERT não é: `snapshot_field_review_cycle` zera a
--      coluna; e o backfill da 20260717120000 reciclou ou apagou, na própria
--      migration, o que marcou), marca o ciclo e, na mesma transação, ou o recicla
--      (pergunta mudou, campo segue divergente) ou o move para o histórico
--      (campo deixou de divergir). Nos dois casos o árbitro é solto e o
--      assignment de arbitragem aberto sai;
--   2. o cliente não grava `superseded_at`: nem o coordenador, nem o árbitro,
--      nem o auto-revisor, cada um na transição que lhe é permitida.
--
-- O contrato cobre os produtores de hoje. Se o reconciliador passar a deixar
-- ciclo superado na tabela, ele reprova; um produtor novo de `superseded_at`
-- precisa entrar aqui. Nos dois casos, os cinco predicados sem
-- `superseded_at` (os dois fechos,
-- `archive_review_dependencies_on_response_change`,
-- `archive_question_changed_field_reviews` e `unify_project_members`)
-- precisam ganhar o filtro.
--
-- A outra metade da sincronia fila×assignment, tirar a permissão de arbitrar,
-- está em member_permission_rpcs.test.sql (solta os `field_reviews` pendentes
-- e apaga o assignment).
--
-- Como rodar (após `npx supabase start` e `npx supabase db reset`):
--   npm run test:db -- arbitration_current_cycle
--
-- Validar pelo exit code, não por contar OKs na saída.
-- Roda inteiro em BEGIN ... ROLLBACK; não deixa fixtures no banco local.

BEGIN;

-- ========== Fixtures ==========
-- C coordena, A codifica e auto-revisa, X é o único membro com can_arbitrate.
INSERT INTO auth.users (id, email) VALUES
  ('31a00000-0000-0000-0000-000000000001', 'coder-a-p31@example.test'),
  ('31a00000-0000-0000-0000-000000000002', 'coord-c-p31@example.test'),
  ('31a00000-0000-0000-0000-000000000003', 'arbitro-x-p31@example.test');

INSERT INTO public.clerk_user_mapping
  (clerk_user_id, supabase_user_id, access_sync_version)
SELECT id::text, id, 1
FROM auth.users
WHERE id::text LIKE '31a00000-0000-0000-0000-%';

INSERT INTO public.projects
  (id, name, created_by, automation_mode, pydantic_hash, pydantic_fields)
VALUES
  ('31b00000-0000-0000-0000-000000000001', 'arbitragem segue o ciclo corrente',
   '31a00000-0000-0000-0000-000000000002', 'auto_review_llm', 'schema-p31',
   '[{"id":"00000000-0000-4000-8000-0000000031a1","name":"q1","type":"text","target":"all","description":"Decidida","hash":"q10000000001"},
     {"id":"00000000-0000-4000-8000-0000000031a2","name":"q2","type":"text","target":"all","description":"Pergunta alterada","hash":"q20000000001"},
     {"id":"00000000-0000-4000-8000-0000000031a3","name":"q3","type":"text","target":"all","description":"Deixa de divergir","hash":"q30000000001"},
     {"id":"00000000-0000-4000-8000-0000000031a4","name":"q4","type":"text","target":"all","description":"Sem veredito proprio","hash":"q40000000001"}]');

INSERT INTO public.documents (id, project_id, title, text, text_hash) VALUES
  ('31c00000-0000-0000-0000-000000000001',
   '31b00000-0000-0000-0000-000000000001', 'doc', 'texto', 'h-p31');

INSERT INTO public.project_members (project_id, user_id, role, can_arbitrate)
VALUES
  ('31b00000-0000-0000-0000-000000000001',
   '31a00000-0000-0000-0000-000000000001', 'pesquisador', false),
  ('31b00000-0000-0000-0000-000000000001',
   '31a00000-0000-0000-0000-000000000002', 'coordenador', false),
  ('31b00000-0000-0000-0000-000000000001',
   '31a00000-0000-0000-0000-000000000003', 'pesquisador', true);

INSERT INTO public.responses
  (id, project_id, document_id, respondent_id, respondent_type, answers)
VALUES
  ('31d00000-0000-0000-0000-000000000001', '31b00000-0000-0000-0000-000000000001',
   '31c00000-0000-0000-0000-000000000001', '31a00000-0000-0000-0000-000000000001',
   'humano', '{"q1":"a","q2":"a","q3":"a","q4":"a"}'),
  ('31d00000-0000-0000-0000-000000000003', '31b00000-0000-0000-0000-000000000001',
   '31c00000-0000-0000-0000-000000000001', NULL,
   'llm', '{"q1":"llm","q2":"llm","q3":"llm","q4":"llm"}');

-- q1, q2 e q3 foram contestados por A e estão com X. q1 já tem veredito
-- final; q2 e q3 estão na fase cega. É o caso relatado: o que resta com X sem
-- veredito final vai ser superado. q4 ainda espera a auto-revisão de A.
INSERT INTO public.field_reviews
  (id, project_id, document_id, field_name, human_response_id, llm_response_id,
   self_reviewer_id, self_verdict, self_reviewed_at, self_justification,
   arbitrator_id, blind_verdict, blind_decided_at, final_verdict, final_decided_at)
VALUES
  ('31f00000-0000-0000-0000-000000000001', '31b00000-0000-0000-0000-000000000001',
   '31c00000-0000-0000-0000-000000000001', 'q1',
   '31d00000-0000-0000-0000-000000000001', '31d00000-0000-0000-0000-000000000003',
   '31a00000-0000-0000-0000-000000000001', 'contesta_llm', now(), 'difere',
   '31a00000-0000-0000-0000-000000000003', 'humano', now(), 'humano', now()),
  ('31f00000-0000-0000-0000-000000000002', '31b00000-0000-0000-0000-000000000001',
   '31c00000-0000-0000-0000-000000000001', 'q2',
   '31d00000-0000-0000-0000-000000000001', '31d00000-0000-0000-0000-000000000003',
   '31a00000-0000-0000-0000-000000000001', 'contesta_llm', now(), 'difere',
   '31a00000-0000-0000-0000-000000000003', 'humano', now(), NULL, NULL),
  ('31f00000-0000-0000-0000-000000000003', '31b00000-0000-0000-0000-000000000001',
   '31c00000-0000-0000-0000-000000000001', 'q3',
   '31d00000-0000-0000-0000-000000000001', '31d00000-0000-0000-0000-000000000003',
   '31a00000-0000-0000-0000-000000000001', 'contesta_llm', now(), 'difere',
   '31a00000-0000-0000-0000-000000000003', NULL, NULL, NULL, NULL),
  ('31f00000-0000-0000-0000-000000000004', '31b00000-0000-0000-0000-000000000001',
   '31c00000-0000-0000-0000-000000000001', 'q4',
   '31d00000-0000-0000-0000-000000000001', '31d00000-0000-0000-0000-000000000003',
   '31a00000-0000-0000-0000-000000000001', NULL, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL);

INSERT INTO public.assignments (id, project_id, document_id, user_id, type, status)
VALUES
  ('31e00000-0000-0000-0000-000000000001', '31b00000-0000-0000-0000-000000000001',
   '31c00000-0000-0000-0000-000000000001', '31a00000-0000-0000-0000-000000000003',
   'arbitragem', 'pendente');

-- ========== 1. O cliente não grava superseded_at ==========
-- Cada ator tenta a transição que o gatilho de fase lhe permite (controle: sem
-- superseded_at ela passa, e é desfeita) e depois a mesma transição levando
-- só superseded_at junto (sem superseded_reason, que seria recusado por conta
-- própria e esconderia um gatilho que deixasse superseded_at passar). O
-- controle é o que garante que a recusa vem de
-- superseded_at, e não de GRANT, RLS ou de uma transição inválida por outro
-- motivo. Quem recusa aqui é enforce_field_review_phase_transition;
-- guard_field_review_update_columns também recusaria, mas sai cedo quando o
-- SESSION_USER é postgres, que é como a suíte roda.
--
-- Um Postgres sem os default privileges do Supabase não concede DML do schema
-- public; o GRANT sai no ROLLBACK.
GRANT SELECT, UPDATE ON public.field_reviews TO authenticated;
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  item RECORD;
  v_rows INTEGER;
  v_outcome TEXT;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('coordenador devolve a arbitragem ao pool',
       '31a00000-0000-0000-0000-000000000002',
       '31f00000-0000-0000-0000-000000000003',
       'arbitrator_id = NULL, blind_verdict = NULL, blind_decided_at = NULL'),
      ('árbitro dá o veredito cego',
       '31a00000-0000-0000-0000-000000000003',
       '31f00000-0000-0000-0000-000000000003',
       'blind_verdict = ''humano'''),
      ('auto-revisor dá o veredito próprio',
       '31a00000-0000-0000-0000-000000000001',
       '31f00000-0000-0000-0000-000000000004',
       'self_verdict = ''admite_erro''')
    ) AS cases(label, actor_id, review_id, transition)
  LOOP
    PERFORM pg_catalog.set_config(
      'request.jwt.claims',
      pg_catalog.jsonb_build_object(
        'sub', item.actor_id, 'supabase_uid', item.actor_id)::TEXT,
      true
    );

    BEGIN
      EXECUTE pg_catalog.format(
        'UPDATE public.field_reviews SET %s WHERE id = %L',
        item.transition, item.review_id);
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      -- Desfaz o controle: a fixture segue como estava para os blocos seguintes.
      RAISE EXCEPTION USING ERRCODE = 'P0P31', MESSAGE = v_rows::TEXT;
    EXCEPTION
      WHEN SQLSTATE 'P0P31' THEN
        v_rows := SQLERRM::INTEGER;
    END;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'FALHOU controle (%): a transição permitida alterou % linha(s)',
        item.label, v_rows;
    END IF;

    BEGIN
      EXECUTE pg_catalog.format(
        'UPDATE public.field_reviews SET %s, superseded_at = now() WHERE id = %L',
        item.transition, item.review_id);
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_outcome := 'gravou ' || v_rows || ' linha(s)';
    EXCEPTION
      WHEN insufficient_privilege THEN
        v_outcome := SQLERRM;
    END;
    IF v_outcome IS DISTINCT FROM
       'field_review phase transition is not allowed for this actor' THEN
      RAISE EXCEPTION 'FALHOU (%): superseded_at não foi recusado pelo gatilho de fase (%)',
        item.label, v_outcome;
    END IF;
  END LOOP;
  RAISE NOTICE 'OK 1: o cliente não grava superseded_at';
END $$;

RESET ROLE;
SELECT pg_catalog.set_config('request.jwt.claims', '{}', true);

-- ========== 2. O reconciliador não deixa ciclo superado para trás ==========
-- q2: a pergunta mudou e o campo segue divergente (o carimbo do ciclo deixa
-- de ser o do schema), então o ciclo é superado e reciclado. q3: deixou de
-- divergir, então o ciclo é superado e arquivado. q1 e q4 não mudam.
DO $$
BEGIN
  -- Controle do bloco 3: antes do reconciliador, X tem a arbitragem aberta.
  IF NOT EXISTS (
    SELECT 1 FROM public.assignments
    WHERE id = '31e00000-0000-0000-0000-000000000001' AND status = 'pendente'
  ) THEN
    RAISE EXCEPTION 'FALHOU fixture: a arbitragem de X não está aberta antes do reconciliador';
  END IF;
END $$;

UPDATE public.field_reviews
SET field_hash = 'q2-versao-anterior'
WHERE id = '31f00000-0000-0000-0000-000000000002';

SET LOCAL request.jwt.claims = '{"role":"service_role"}';
SELECT public.reconcile_auto_review_cycles(jsonb_build_array(jsonb_build_object(
  'human_response_id', '31d00000-0000-0000-0000-000000000001',
  'llm_response_id', '31d00000-0000-0000-0000-000000000003',
  'field_names', '["q1","q2","q3","q4"]'::jsonb,
  'divergent_field_names', '["q1","q2","q4"]'::jsonb,
  'expected_human_updated_at',
    (SELECT updated_at FROM public.responses
     WHERE id = '31d00000-0000-0000-0000-000000000001'),
  'expected_llm_updated_at',
    (SELECT updated_at FROM public.responses
     WHERE id = '31d00000-0000-0000-0000-000000000003'),
  'expected_project_pydantic_hash', 'schema-p31',
  'expected_equivalence_ids', '[]'::jsonb
)));
RESET request.jwt.claims;

DO $$
DECLARE
  v_q2 public.field_reviews%ROWTYPE;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.field_reviews
    WHERE project_id = '31b00000-0000-0000-0000-000000000001'
      AND superseded_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'FALHOU: o reconciliador deixou ciclo superado em field_reviews';
  END IF;

  -- Os dois ciclos superados estão no histórico, com o árbitro que tinham.
  IF (
    SELECT count(*) FROM public.field_review_cycle_history_entries
    WHERE id IN ('31f00000-0000-0000-0000-000000000002',
                 '31f00000-0000-0000-0000-000000000003')
      AND arbitrator_id = '31a00000-0000-0000-0000-000000000003'
      AND superseded_at IS NOT NULL
  ) <> 2 THEN
    RAISE EXCEPTION 'FALHOU: ciclo superado não foi para o histórico';
  END IF;

  -- q2 voltou como ciclo novo, sem árbitro e sem veredito; q3 saiu.
  SELECT * INTO v_q2 FROM public.field_reviews
  WHERE document_id = '31c00000-0000-0000-0000-000000000001'
    AND field_name = 'q2';
  IF v_q2.id IS NULL
     OR v_q2.id = '31f00000-0000-0000-0000-000000000002'
     OR v_q2.cycle_no <> 2
     OR v_q2.self_verdict IS NOT NULL
     OR v_q2.arbitrator_id IS NOT NULL
     OR v_q2.blind_verdict IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU: q2 não voltou como ciclo novo sem árbitro (%)',
      row_to_json(v_q2);
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.field_reviews
    WHERE document_id = '31c00000-0000-0000-0000-000000000001'
      AND field_name = 'q3'
  ) THEN
    RAISE EXCEPTION 'FALHOU: q3 deixou de divergir e seguiu em field_reviews';
  END IF;

  -- q1, já decidido, não é tocado.
  IF NOT EXISTS (
    SELECT 1 FROM public.field_reviews
    WHERE id = '31f00000-0000-0000-0000-000000000001'
      AND arbitrator_id = '31a00000-0000-0000-0000-000000000003'
      AND final_verdict = 'humano'
  ) THEN
    RAISE EXCEPTION 'FALHOU: o reconciliador mexeu no ciclo já decidido';
  END IF;
  RAISE NOTICE 'OK 2: ciclo superado é reciclado ou arquivado na mesma transação';
END $$;

-- ========== 3. Sem campo pendente, o assignment de arbitragem não fica aberto ==========
-- O que X ainda tinha sem veredito final era só de ciclo superado (o bloco 2
-- mostra que nada ficou com ele): nenhum assignment aberto pode sobrar.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.assignments
    WHERE project_id = '31b00000-0000-0000-0000-000000000001'
      AND document_id = '31c00000-0000-0000-0000-000000000001'
      AND user_id = '31a00000-0000-0000-0000-000000000003'
      AND type = 'arbitragem'
      AND status <> 'concluido'
  ) THEN
    RAISE EXCEPTION 'FALHOU: assignment de arbitragem ficou aberto sem campo pendente';
  END IF;
  RAISE NOTICE 'OK 3: assignment de arbitragem não fica aberto sem campo pendente';
END $$;

ROLLBACK;
