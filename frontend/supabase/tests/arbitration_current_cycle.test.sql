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
--      operacional, marca o ciclo e, na mesma transação, ou o recicla
--      (pergunta mudou, campo segue divergente) ou o move para o histórico
--      (campo deixou de divergir). Nos dois casos o árbitro é solto e o
--      assignment de arbitragem aberto sai;
--   2. o cliente não grava `superseded_at`, nem como coordenador.
--
-- Se um dia o reconciliador passar a deixar ciclo superado na tabela, este
-- contrato reprova, e aí os cinco predicados sem `superseded_at` (os dois
-- fechos, `archive_review_dependencies_on_response_change`,
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
     {"id":"00000000-0000-4000-8000-0000000031a3","name":"q3","type":"text","target":"all","description":"Deixa de divergir","hash":"q30000000001"}]');

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
   'humano', '{"q1":"a","q2":"a","q3":"a"}'),
  ('31d00000-0000-0000-0000-000000000003', '31b00000-0000-0000-0000-000000000001',
   '31c00000-0000-0000-0000-000000000001', NULL,
   'llm', '{"q1":"llm","q2":"llm","q3":"llm"}');

-- Os três campos foram contestados por A e estão com X. q1 já tem veredito
-- final; q2 e q3 estão na fase cega. É o caso relatado: o que resta sem
-- veredito final vai ser superado.
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
   '31a00000-0000-0000-0000-000000000003', NULL, NULL, NULL, NULL);

INSERT INTO public.assignments (id, project_id, document_id, user_id, type, status)
VALUES
  ('31e00000-0000-0000-0000-000000000001', '31b00000-0000-0000-0000-000000000001',
   '31c00000-0000-0000-0000-000000000001', '31a00000-0000-0000-0000-000000000003',
   'arbitragem', 'pendente');

-- ========== 1. O cliente não grava superseded_at ==========
-- O coordenador é quem mais pode em field_reviews (policy de UPDATE); nem ele
-- marca um ciclo como superado.
SELECT pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"31a00000-0000-0000-0000-000000000002","supabase_uid":"31a00000-0000-0000-0000-000000000002"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_refused BOOLEAN := false;
BEGIN
  BEGIN
    UPDATE public.field_reviews
    SET superseded_at = now(), superseded_reason = 'answer_changed'
    WHERE id = '31f00000-0000-0000-0000-000000000003';
  EXCEPTION
    WHEN raise_exception OR insufficient_privilege THEN
      v_refused := true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'FALHOU: coordenador gravou superseded_at em field_reviews';
  END IF;
END $$;

RESET ROLE;
SELECT pg_catalog.set_config('request.jwt.claims', '{}', true);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.field_reviews
    WHERE project_id = '31b00000-0000-0000-0000-000000000001'
      AND superseded_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'FALHOU: superseded_at ficou gravado pelo cliente';
  END IF;
  RAISE NOTICE 'OK 1: o cliente não grava superseded_at';
END $$;

-- ========== 2. O reconciliador não deixa ciclo superado para trás ==========
-- q2: a pergunta mudou e o campo segue divergente (o carimbo do ciclo deixa
-- de ser o do schema), então o ciclo é superado e reciclado. q3: deixou de
-- divergir, então o ciclo é superado e arquivado. q1 não muda.
UPDATE public.field_reviews
SET field_hash = 'q2-versao-anterior'
WHERE id = '31f00000-0000-0000-0000-000000000002';

SET LOCAL request.jwt.claims = '{"role":"service_role"}';
SELECT public.reconcile_auto_review_cycles(jsonb_build_array(jsonb_build_object(
  'human_response_id', '31d00000-0000-0000-0000-000000000001',
  'llm_response_id', '31d00000-0000-0000-0000-000000000003',
  'field_names', '["q1","q2","q3"]'::jsonb,
  'divergent_field_names', '["q1","q2"]'::jsonb,
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
-- O que X ainda tinha sem veredito final era só de ciclo superado: nada mais
-- na fila dele, e nenhum assignment aberto apontando para esse documento.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.field_reviews
    WHERE project_id = '31b00000-0000-0000-0000-000000000001'
      AND arbitrator_id = '31a00000-0000-0000-0000-000000000003'
      AND final_verdict IS NULL
  ) THEN
    RAISE EXCEPTION 'FALHOU: sobrou campo pendente com o árbitro';
  END IF;
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
