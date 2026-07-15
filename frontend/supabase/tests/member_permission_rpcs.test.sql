-- Regressão das RPCs atômicas de membro e do commit final de assignments.
--
-- Como rodar depois de `npx supabase start` e `npx supabase db reset`:
--   docker exec -i supabase_db_frontend psql -U postgres -d postgres \
--     -X -v ON_ERROR_STOP=1 < supabase/tests/member_permission_rpcs.test.sql
--
-- O teste inteiro roda em BEGIN ... ROLLBACK. Os GRANTs abaixo compensam o
-- ambiente local, que não concede DML às roles da API, e também são revertidos.

BEGIN;

-- ----- Fixtures -----
INSERT INTO auth.users (id, email) VALUES
  ('93000000-0000-0000-0000-000000000011', 'coordinator-rpc@example.test'),
  ('93000000-0000-0000-0000-000000000012', 'researcher-rpc@example.test'),
  ('93000000-0000-0000-0000-000000000013', 'target-happy-rpc@example.test'),
  ('93000000-0000-0000-0000-000000000014', 'target-rollback-rpc@example.test'),
  ('93000000-0000-0000-0000-000000000015', 'other-coordinator-rpc@example.test'),
  ('93000000-0000-0000-0000-000000000016', 'other-target-rpc@example.test'),
  ('93000000-0000-0000-0000-000000000017', 'alias-happy-rpc@example.test'),
  ('93000000-0000-0000-0000-000000000018', 'alias-rollback-rpc@example.test');

INSERT INTO public.projects (id, name, created_by) VALUES
  ('90000000-0000-0000-0000-000000000001', 'member permission RPC test',
   '93000000-0000-0000-0000-000000000011'),
  ('90000000-0000-0000-0000-000000000002', 'cross-project IDOR test',
   '93000000-0000-0000-0000-000000000015');

INSERT INTO public.project_members
  (id, project_id, user_id, role, can_arbitrate, can_compare)
VALUES
  ('92000000-0000-0000-0000-000000000011', '90000000-0000-0000-0000-000000000001',
   '93000000-0000-0000-0000-000000000011', 'coordenador', true, true),
  ('92000000-0000-0000-0000-000000000012', '90000000-0000-0000-0000-000000000001',
   '93000000-0000-0000-0000-000000000012', 'pesquisador', true, true),
  ('92000000-0000-0000-0000-000000000013', '90000000-0000-0000-0000-000000000001',
   '93000000-0000-0000-0000-000000000013', 'pesquisador', true, true),
  ('92000000-0000-0000-0000-000000000014', '90000000-0000-0000-0000-000000000001',
   '93000000-0000-0000-0000-000000000014', 'pesquisador', true, true),
  ('92000000-0000-0000-0000-000000000015', '90000000-0000-0000-0000-000000000002',
   '93000000-0000-0000-0000-000000000015', 'coordenador', true, true),
  ('92000000-0000-0000-0000-000000000016', '90000000-0000-0000-0000-000000000002',
   '93000000-0000-0000-0000-000000000016', 'pesquisador', true, true);

INSERT INTO public.documents (id, project_id, title, text) VALUES
  ('94000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-000000000001', 'arbitragem pendente', 'd1'),
  ('94000000-0000-0000-0000-000000000002', '90000000-0000-0000-0000-000000000001', 'arbitragem concluída', 'd2'),
  ('94000000-0000-0000-0000-000000000003', '90000000-0000-0000-0000-000000000001', 'comparação pendente', 'd3'),
  ('94000000-0000-0000-0000-000000000004', '90000000-0000-0000-0000-000000000001', 'comparação em andamento', 'd4'),
  ('94000000-0000-0000-0000-000000000005', '90000000-0000-0000-0000-000000000001', 'rollback arbitragem', 'd5'),
  ('94000000-0000-0000-0000-000000000006', '90000000-0000-0000-0000-000000000001', 'rollback comparação', 'd6'),
  ('94000000-0000-0000-0000-000000000007', '90000000-0000-0000-0000-000000000002', 'IDOR arbitragem', 'd7'),
  ('94000000-0000-0000-0000-000000000008', '90000000-0000-0000-0000-000000000002', 'IDOR comparação', 'd8');

INSERT INTO public.responses
  (id, project_id, document_id, respondent_id, respondent_type, answers)
VALUES
  ('95000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-000000000001',
   '94000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000012', 'humano', '{}'),
  ('95000000-0000-0000-0000-000000000002', '90000000-0000-0000-0000-000000000001',
   '94000000-0000-0000-0000-000000000001', NULL, 'llm', '{}'),
  ('95000000-0000-0000-0000-000000000003', '90000000-0000-0000-0000-000000000001',
   '94000000-0000-0000-0000-000000000002', '93000000-0000-0000-0000-000000000012', 'humano', '{}'),
  ('95000000-0000-0000-0000-000000000004', '90000000-0000-0000-0000-000000000001',
   '94000000-0000-0000-0000-000000000002', NULL, 'llm', '{}'),
  ('95000000-0000-0000-0000-000000000005', '90000000-0000-0000-0000-000000000001',
   '94000000-0000-0000-0000-000000000005', '93000000-0000-0000-0000-000000000012', 'humano', '{}'),
  ('95000000-0000-0000-0000-000000000006', '90000000-0000-0000-0000-000000000001',
   '94000000-0000-0000-0000-000000000005', NULL, 'llm', '{}'),
  ('95000000-0000-0000-0000-000000000007', '90000000-0000-0000-0000-000000000002',
   '94000000-0000-0000-0000-000000000007', '93000000-0000-0000-0000-000000000015', 'humano', '{}'),
  ('95000000-0000-0000-0000-000000000008', '90000000-0000-0000-0000-000000000002',
   '94000000-0000-0000-0000-000000000007', NULL, 'llm', '{}'),
  ('95000000-0000-0000-0000-000000000009', '90000000-0000-0000-0000-000000000002',
   '94000000-0000-0000-0000-000000000008', '93000000-0000-0000-0000-000000000015', 'humano', '{}'),
  ('95000000-0000-0000-0000-000000000010', '90000000-0000-0000-0000-000000000002',
   '94000000-0000-0000-0000-000000000008', NULL, 'llm', '{}');

INSERT INTO public.field_reviews
  (id, project_id, document_id, field_name, human_response_id, llm_response_id,
   self_reviewer_id, self_verdict, arbitrator_id, blind_verdict,
   blind_decided_at, final_verdict, final_decided_at)
VALUES
  ('97000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-000000000001',
   '94000000-0000-0000-0000-000000000001', 'field_a',
   '95000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-000000000002',
   '93000000-0000-0000-0000-000000000012', 'contesta_llm',
   '93000000-0000-0000-0000-000000000013', 'humano', now(), NULL, NULL),
  ('97000000-0000-0000-0000-000000000002', '90000000-0000-0000-0000-000000000001',
   '94000000-0000-0000-0000-000000000002', 'field_a',
   '95000000-0000-0000-0000-000000000003', '95000000-0000-0000-0000-000000000004',
   '93000000-0000-0000-0000-000000000012', 'contesta_llm',
   '93000000-0000-0000-0000-000000000013', 'humano', now(), 'humano', now()),
  ('97000000-0000-0000-0000-000000000003', '90000000-0000-0000-0000-000000000001',
   '94000000-0000-0000-0000-000000000005', 'field_a',
   '95000000-0000-0000-0000-000000000005', '95000000-0000-0000-0000-000000000006',
   '93000000-0000-0000-0000-000000000012', 'contesta_llm',
   '93000000-0000-0000-0000-000000000014', 'llm', now(), NULL, NULL),
  ('97000000-0000-0000-0000-000000000004', '90000000-0000-0000-0000-000000000002',
   '94000000-0000-0000-0000-000000000007', 'field_a',
   '95000000-0000-0000-0000-000000000007', '95000000-0000-0000-0000-000000000008',
   '93000000-0000-0000-0000-000000000015', 'contesta_llm',
   '93000000-0000-0000-0000-000000000016', 'humano', now(), NULL, NULL);

INSERT INTO public.assignments
  (id, project_id, document_id, user_id, status, type)
VALUES
  ('96000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-000000000001',
   '94000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000013', 'em_andamento', 'arbitragem'),
  ('96000000-0000-0000-0000-000000000002', '90000000-0000-0000-0000-000000000001',
   '94000000-0000-0000-0000-000000000002', '93000000-0000-0000-0000-000000000013', 'concluido', 'arbitragem'),
  ('96000000-0000-0000-0000-000000000003', '90000000-0000-0000-0000-000000000001',
   '94000000-0000-0000-0000-000000000003', '93000000-0000-0000-0000-000000000013', 'pendente', 'comparacao'),
  ('96000000-0000-0000-0000-000000000004', '90000000-0000-0000-0000-000000000001',
   '94000000-0000-0000-0000-000000000004', '93000000-0000-0000-0000-000000000013', 'em_andamento', 'comparacao'),
  ('96000000-0000-0000-0000-000000000005', '90000000-0000-0000-0000-000000000001',
   '94000000-0000-0000-0000-000000000005', '93000000-0000-0000-0000-000000000014', 'em_andamento', 'arbitragem'),
  ('96000000-0000-0000-0000-000000000006', '90000000-0000-0000-0000-000000000001',
   '94000000-0000-0000-0000-000000000006', '93000000-0000-0000-0000-000000000014', 'pendente', 'comparacao'),
  ('96000000-0000-0000-0000-000000000007', '90000000-0000-0000-0000-000000000002',
   '94000000-0000-0000-0000-000000000007', '93000000-0000-0000-0000-000000000016', 'em_andamento', 'arbitragem'),
  ('96000000-0000-0000-0000-000000000008', '90000000-0000-0000-0000-000000000002',
   '94000000-0000-0000-0000-000000000008', '93000000-0000-0000-0000-000000000016', 'pendente', 'comparacao'),
  ('96000000-0000-0000-0000-000000000009', '90000000-0000-0000-0000-000000000001',
   '94000000-0000-0000-0000-000000000004', '93000000-0000-0000-0000-000000000013', 'pendente', 'auto_revisao');

INSERT INTO public.member_email_links
  (id, project_id, member_user_id, email, linked_user_id, created_by)
VALUES
  ('98000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-000000000001',
   '93000000-0000-0000-0000-000000000013', 'alias-happy-rpc@example.test',
   '93000000-0000-0000-0000-000000000017', '93000000-0000-0000-0000-000000000011'),
  ('98000000-0000-0000-0000-000000000002', '90000000-0000-0000-0000-000000000001',
   '93000000-0000-0000-0000-000000000014', 'alias-rollback-rpc@example.test',
   '93000000-0000-0000-0000-000000000018', '93000000-0000-0000-0000-000000000011');

GRANT SELECT, UPDATE, DELETE ON public.project_members TO authenticated;
GRANT SELECT, UPDATE ON public.field_reviews TO authenticated;
GRANT SELECT, DELETE ON public.assignments TO authenticated;
GRANT SELECT, DELETE ON public.member_email_links TO authenticated;
GRANT SELECT, UPDATE ON public.project_members TO service_role;
GRANT SELECT, UPDATE ON public.field_reviews TO service_role;
GRANT SELECT, INSERT ON public.assignments TO service_role;

CREATE TEMP TABLE permission_rpc_results (
  name text PRIMARY KEY,
  row_count integer NOT NULL,
  project_id uuid
);
GRANT SELECT, INSERT ON permission_rpc_results TO authenticated;

-- ----- ACL: as RPCs não ficam expostas a anon/service_role/PUBLIC -----
DO $$
BEGIN
  IF NOT has_function_privilege(
    'authenticated', 'public.set_member_arbitration_permission(uuid,boolean)', 'EXECUTE'
  ) OR NOT has_function_privilege(
    'authenticated', 'public.set_member_comparison_permission(uuid,boolean)', 'EXECUTE'
  ) OR NOT has_function_privilege(
    'authenticated', 'public.remove_project_member(uuid)', 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'FALHOU ACL: authenticated sem EXECUTE nas RPCs de membro';
  END IF;
  IF has_function_privilege(
    'anon', 'public.set_member_arbitration_permission(uuid,boolean)', 'EXECUTE'
  ) OR has_function_privilege(
    'anon', 'public.set_member_comparison_permission(uuid,boolean)', 'EXECUTE'
  ) OR has_function_privilege(
    'service_role', 'public.set_member_arbitration_permission(uuid,boolean)', 'EXECUTE'
  ) OR has_function_privilege(
    'service_role', 'public.set_member_comparison_permission(uuid,boolean)', 'EXECUTE'
  ) OR has_function_privilege(
    'anon', 'public.remove_project_member(uuid)', 'EXECUTE'
  ) OR has_function_privilege(
    'service_role', 'public.remove_project_member(uuid)', 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'FALHOU ACL: RPC de membro disponível a outra role da API';
  END IF;
  IF NOT has_function_privilege(
    'service_role',
    'public.assign_arbitration_if_eligible(uuid,uuid,uuid,text[])',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'public.assign_comparison_if_eligible(uuid,uuid,uuid)',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.assign_arbitration_if_eligible(uuid,uuid,uuid,text[])',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.assign_comparison_if_eligible(uuid,uuid,uuid)',
    'EXECUTE'
  ) OR has_function_privilege(
    'anon',
    'public.assign_arbitration_if_eligible(uuid,uuid,uuid,text[])',
    'EXECUTE'
  ) OR has_function_privilege(
    'anon',
    'public.assign_comparison_if_eligible(uuid,uuid,uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'FALHOU ACL: commit de assignment fora da service_role';
  END IF;
  RAISE NOTICE 'OK ACL: RPCs de membro e assignment têm roles mínimas';
END $$;

-- ----- RLS: pesquisador vê o membro, mas não altera nem libera trabalho -----
SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"93000000-0000-0000-0000-000000000012"}',
  true
);
SET LOCAL ROLE authenticated;

WITH result AS MATERIALIZED (
  SELECT * FROM public.set_member_arbitration_permission(
    '92000000-0000-0000-0000-000000000013', false
  )
)
INSERT INTO permission_rpc_results
SELECT 'noncoordinator-arbitration',
       (SELECT count(*) FROM result),
       (SELECT project_id FROM result);

WITH result AS MATERIALIZED (
  SELECT * FROM public.set_member_comparison_permission(
    '92000000-0000-0000-0000-000000000013', false
  )
)
INSERT INTO permission_rpc_results
SELECT 'noncoordinator-comparison',
       (SELECT count(*) FROM result),
       (SELECT project_id FROM result);

RESET ROLE;

DO $$
DECLARE
  v_can_arbitrate boolean;
  v_can_compare boolean;
  v_assignment_count integer;
  v_arbitrator_id uuid;
BEGIN
  IF EXISTS (
    SELECT 1 FROM permission_rpc_results
    WHERE name LIKE 'noncoordinator-%' AND row_count <> 0
  ) THEN
    RAISE EXCEPTION 'FALHOU RLS: pesquisador recebeu linha de uma RPC de coordenador';
  END IF;

  SELECT can_arbitrate, can_compare
  INTO v_can_arbitrate, v_can_compare
  FROM public.project_members
  WHERE id = '92000000-0000-0000-0000-000000000013';
  SELECT arbitrator_id INTO v_arbitrator_id
  FROM public.field_reviews
  WHERE id = '97000000-0000-0000-0000-000000000001';
  SELECT count(*) INTO v_assignment_count
  FROM public.assignments
  WHERE id IN (
    '96000000-0000-0000-0000-000000000001',
    '96000000-0000-0000-0000-000000000003'
  );

  IF v_can_arbitrate IS DISTINCT FROM true
     OR v_can_compare IS DISTINCT FROM true
     OR v_arbitrator_id IS DISTINCT FROM '93000000-0000-0000-0000-000000000013'
     OR v_assignment_count <> 2 THEN
    RAISE EXCEPTION 'FALHOU RLS: pesquisador produziu efeito colateral';
  END IF;
  RAISE NOTICE 'OK RLS: pesquisador não alterou flags nem liberou trabalho';
END $$;

-- ----- IDOR: coordenador de A não altera membro nem trabalho de B -----
SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"93000000-0000-0000-0000-000000000011"}',
  true
);
SET LOCAL ROLE authenticated;

WITH result AS MATERIALIZED (
  SELECT * FROM public.set_member_arbitration_permission(
    '92000000-0000-0000-0000-000000000016', false
  )
)
INSERT INTO permission_rpc_results
SELECT 'cross-project-arbitration',
       (SELECT count(*) FROM result),
       (SELECT project_id FROM result);

WITH result AS MATERIALIZED (
  SELECT * FROM public.set_member_comparison_permission(
    '92000000-0000-0000-0000-000000000016', false
  )
)
INSERT INTO permission_rpc_results
SELECT 'cross-project-comparison',
       (SELECT count(*) FROM result),
       (SELECT project_id FROM result);

WITH result AS MATERIALIZED (
  SELECT * FROM public.remove_project_member(
    '92000000-0000-0000-0000-000000000016'
  )
)
INSERT INTO permission_rpc_results
SELECT 'cross-project-remove',
       (SELECT count(*) FROM result),
       (SELECT project_id FROM result);

RESET ROLE;

DO $$
DECLARE
  v_can_arbitrate boolean;
  v_can_compare boolean;
  v_arbitrator_id uuid;
  v_assignment_count integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM permission_rpc_results
    WHERE name LIKE 'cross-project-%' AND row_count <> 0
  ) THEN
    RAISE EXCEPTION 'FALHOU IDOR: coordenador recebeu linha de outro projeto';
  END IF;

  SELECT can_arbitrate, can_compare
  INTO v_can_arbitrate, v_can_compare
  FROM public.project_members
  WHERE id = '92000000-0000-0000-0000-000000000016';
  SELECT arbitrator_id INTO v_arbitrator_id
  FROM public.field_reviews
  WHERE id = '97000000-0000-0000-0000-000000000004';
  SELECT count(*) INTO v_assignment_count
  FROM public.assignments
  WHERE id IN (
    '96000000-0000-0000-0000-000000000007',
    '96000000-0000-0000-0000-000000000008'
  );

  IF v_can_arbitrate IS DISTINCT FROM true
     OR v_can_compare IS DISTINCT FROM true
     OR v_arbitrator_id IS DISTINCT FROM '93000000-0000-0000-0000-000000000016'
     OR v_assignment_count <> 2 THEN
    RAISE EXCEPTION 'FALHOU IDOR: coordenador alterou estado de outro projeto';
  END IF;
  RAISE NOTICE 'OK IDOR: coordenador de A não altera membro nem trabalho de B';
END $$;

-- ----- Caminho feliz: desabilita/limpa e habilita sem limpar -----
SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"93000000-0000-0000-0000-000000000011"}',
  true
);
SET LOCAL ROLE authenticated;

WITH result AS MATERIALIZED (
  SELECT * FROM public.set_member_arbitration_permission(
    '92000000-0000-0000-0000-000000000013', false
  )
)
INSERT INTO permission_rpc_results
SELECT 'happy-arbitration-disable',
       (SELECT count(*) FROM result),
       (SELECT project_id FROM result);

WITH result AS MATERIALIZED (
  SELECT * FROM public.set_member_comparison_permission(
    '92000000-0000-0000-0000-000000000013', false
  )
)
INSERT INTO permission_rpc_results
SELECT 'happy-comparison-disable',
       (SELECT count(*) FROM result),
       (SELECT project_id FROM result);

WITH result AS MATERIALIZED (
  SELECT * FROM public.set_member_arbitration_permission(
    '92000000-0000-0000-0000-000000000013', true
  )
)
INSERT INTO permission_rpc_results
SELECT 'happy-arbitration-enable',
       (SELECT count(*) FROM result),
       (SELECT project_id FROM result);

WITH result AS MATERIALIZED (
  SELECT * FROM public.set_member_comparison_permission(
    '92000000-0000-0000-0000-000000000013', true
  )
)
INSERT INTO permission_rpc_results
SELECT 'happy-comparison-enable',
       (SELECT count(*) FROM result),
       (SELECT project_id FROM result);

RESET ROLE;

DO $$
DECLARE
  v_pending_arbitrator uuid;
  v_pending_blind text;
  v_completed_arbitrator uuid;
  v_assignment_count integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM permission_rpc_results
    WHERE name LIKE 'happy-%'
      AND (
        row_count <> 1
        OR project_id <> '90000000-0000-0000-0000-000000000001'
      )
  ) THEN
    RAISE EXCEPTION 'FALHOU happy path: retorno inesperado das RPCs';
  END IF;

  SELECT arbitrator_id, blind_verdict
  INTO v_pending_arbitrator, v_pending_blind
  FROM public.field_reviews
  WHERE id = '97000000-0000-0000-0000-000000000001';
  SELECT arbitrator_id INTO v_completed_arbitrator
  FROM public.field_reviews
  WHERE id = '97000000-0000-0000-0000-000000000002';

  IF v_pending_arbitrator IS NOT NULL OR v_pending_blind IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU arbitragem: revisão pendente não foi liberada do zero';
  END IF;
  IF v_completed_arbitrator <> '93000000-0000-0000-0000-000000000013' THEN
    RAISE EXCEPTION 'FALHOU arbitragem: revisão concluída foi alterada';
  END IF;

  SELECT count(*) INTO v_assignment_count
  FROM public.assignments
  WHERE id IN (
    '96000000-0000-0000-0000-000000000001',
    '96000000-0000-0000-0000-000000000003'
  );
  IF v_assignment_count <> 0 THEN
    RAISE EXCEPTION 'FALHOU limpeza: assignment liberável permaneceu';
  END IF;
  SELECT count(*) INTO v_assignment_count
  FROM public.assignments
  WHERE id IN (
    '96000000-0000-0000-0000-000000000002',
    '96000000-0000-0000-0000-000000000004'
  );
  IF v_assignment_count <> 2 THEN
    RAISE EXCEPTION 'FALHOU limpeza: assignment concluído/em andamento foi removido';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.project_members
    WHERE id = '92000000-0000-0000-0000-000000000013'
      AND can_arbitrate = true
      AND can_compare = true
  ) THEN
    RAISE EXCEPTION 'FALHOU enable: flags não voltaram a true';
  END IF;
  RAISE NOTICE 'OK happy path: flags, limpezas e retornos preservam o contrato';
END $$;

-- ----- Commit final: revalida elegibilidade e serializa com o disable -----
SET LOCAL ROLE service_role;

DO $$
BEGIN
  IF public.assign_arbitration_if_eligible(
    '90000000-0000-0000-0000-000000000001',
    '94000000-0000-0000-0000-000000000001',
    '93000000-0000-0000-0000-000000000013',
    ARRAY['field_a']
  ) <> 1 THEN
    RAISE EXCEPTION 'FALHOU commit: arbitragem elegível não foi gravada';
  END IF;
  IF NOT public.assign_comparison_if_eligible(
    '90000000-0000-0000-0000-000000000001',
    '94000000-0000-0000-0000-000000000003',
    '93000000-0000-0000-0000-000000000013'
  ) THEN
    RAISE EXCEPTION 'FALHOU commit: comparação elegível não foi gravada';
  END IF;
END $$;

RESET ROLE;

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"93000000-0000-0000-0000-000000000011"}',
  true
);
SET LOCAL ROLE authenticated;

SELECT * FROM public.set_member_arbitration_permission(
  '92000000-0000-0000-0000-000000000013', false
);
SELECT * FROM public.set_member_comparison_permission(
  '92000000-0000-0000-0000-000000000013', false
);

RESET ROLE;
SET LOCAL ROLE service_role;

DO $$
BEGIN
  IF public.assign_arbitration_if_eligible(
    '90000000-0000-0000-0000-000000000001',
    '94000000-0000-0000-0000-000000000001',
    '93000000-0000-0000-0000-000000000013',
    ARRAY['field_a']
  ) <> 0 THEN
    RAISE EXCEPTION 'FALHOU commit: árbitro desabilitado recebeu trabalho';
  END IF;
  IF public.assign_comparison_if_eligible(
    '90000000-0000-0000-0000-000000000001',
    '94000000-0000-0000-0000-000000000003',
    '93000000-0000-0000-0000-000000000013'
  ) THEN
    RAISE EXCEPTION 'FALHOU commit: comparador desabilitado recebeu trabalho';
  END IF;
END $$;

RESET ROLE;

DO $$
DECLARE
  v_assignment_count integer;
  v_arbitrator_id uuid;
BEGIN
  SELECT arbitrator_id INTO v_arbitrator_id
  FROM public.field_reviews
  WHERE id = '97000000-0000-0000-0000-000000000001';
  SELECT count(*) INTO v_assignment_count
  FROM public.assignments
  WHERE project_id = '90000000-0000-0000-0000-000000000001'
    AND user_id = '93000000-0000-0000-0000-000000000013'
    AND status = 'pendente'
    AND type IN ('arbitragem', 'comparacao');

  IF v_arbitrator_id IS NOT NULL OR v_assignment_count <> 0 THEN
    RAISE EXCEPTION 'FALHOU serialização: disable não limpou commit anterior';
  END IF;
  RAISE NOTICE 'OK serialização: commit final respeita elegibilidade e limpeza';
END $$;

-- ----- Rollback: falha no DELETE desfaz também flag e field_review -----
CREATE FUNCTION public.test_fail_member_permission_cleanup()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.id IN (
    '96000000-0000-0000-0000-000000000005',
    '96000000-0000-0000-0000-000000000006'
  ) THEN
    RAISE EXCEPTION 'falha de limpeza injetada pelo teste'
      USING ERRCODE = 'P7501';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER test_fail_member_permission_cleanup
  BEFORE DELETE ON public.assignments
  FOR EACH ROW EXECUTE FUNCTION public.test_fail_member_permission_cleanup();

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"93000000-0000-0000-0000-000000000011"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
BEGIN
  PERFORM * FROM public.set_member_arbitration_permission(
    '92000000-0000-0000-0000-000000000014', false
  );
  RAISE EXCEPTION 'FALHOU rollback: arbitragem não propagou a falha injetada';
EXCEPTION
  WHEN SQLSTATE 'P7501' THEN
    NULL;
END $$;

DO $$
BEGIN
  PERFORM * FROM public.set_member_comparison_permission(
    '92000000-0000-0000-0000-000000000014', false
  );
  RAISE EXCEPTION 'FALHOU rollback: comparação não propagou a falha injetada';
EXCEPTION
  WHEN SQLSTATE 'P7501' THEN
    NULL;
END $$;

RESET ROLE;

DO $$
DECLARE
  v_can_arbitrate boolean;
  v_can_compare boolean;
  v_arbitrator_id uuid;
  v_blind_verdict text;
  v_assignment_count integer;
BEGIN
  SELECT can_arbitrate, can_compare
  INTO v_can_arbitrate, v_can_compare
  FROM public.project_members
  WHERE id = '92000000-0000-0000-0000-000000000014';
  SELECT arbitrator_id, blind_verdict
  INTO v_arbitrator_id, v_blind_verdict
  FROM public.field_reviews
  WHERE id = '97000000-0000-0000-0000-000000000003';
  SELECT count(*) INTO v_assignment_count
  FROM public.assignments
  WHERE id IN (
    '96000000-0000-0000-0000-000000000005',
    '96000000-0000-0000-0000-000000000006'
  );

  IF NOT v_can_arbitrate OR NOT v_can_compare
     OR v_arbitrator_id <> '93000000-0000-0000-0000-000000000014'
     OR v_blind_verdict <> 'llm'
     OR v_assignment_count <> 2 THEN
    RAISE EXCEPTION 'FALHOU rollback: a chamada deixou alteração parcial';
  END IF;
  RAISE NOTICE 'OK rollback: falhas de limpeza desfizeram flags, revisão e assignments';
END $$;

-- ----- Remoção: membership, pendências e aliases formam uma transação -----
SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"93000000-0000-0000-0000-000000000011"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_project_id uuid;
BEGIN
  SELECT project_id INTO v_project_id
  FROM public.remove_project_member(
    '92000000-0000-0000-0000-000000000013'
  );
  IF v_project_id IS DISTINCT FROM '90000000-0000-0000-0000-000000000001' THEN
    RAISE EXCEPTION 'FALHOU remoção: RPC não retornou o projeto canônico';
  END IF;
END $$;

DO $$
BEGIN
  PERFORM * FROM public.remove_project_member(
    '92000000-0000-0000-0000-000000000014'
  );
  RAISE EXCEPTION 'FALHOU remoção: falha de limpeza não foi propagada';
EXCEPTION
  WHEN SQLSTATE 'P7501' THEN
    NULL;
END $$;

RESET ROLE;

DO $$
DECLARE
  v_historical_count integer;
  v_rollback_assignment_count integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.project_members
    WHERE id = '92000000-0000-0000-0000-000000000013'
  ) OR EXISTS (
    SELECT 1 FROM public.member_email_links
    WHERE id = '98000000-0000-0000-0000-000000000001'
  ) OR EXISTS (
    SELECT 1 FROM public.assignments
    WHERE id = '96000000-0000-0000-0000-000000000009'
  ) THEN
    RAISE EXCEPTION 'FALHOU remoção: acesso ou pendência sobreviveu ao sucesso';
  END IF;

  SELECT count(*) INTO v_historical_count
  FROM public.assignments
  WHERE id IN (
    '96000000-0000-0000-0000-000000000002',
    '96000000-0000-0000-0000-000000000004'
  );
  IF v_historical_count <> 2 THEN
    RAISE EXCEPTION 'FALHOU remoção: trabalho iniciado/concluído foi apagado';
  END IF;

  SELECT count(*) INTO v_rollback_assignment_count
  FROM public.assignments
  WHERE id IN (
    '96000000-0000-0000-0000-000000000005',
    '96000000-0000-0000-0000-000000000006'
  );

  IF NOT EXISTS (
    SELECT 1 FROM public.project_members
    WHERE id = '92000000-0000-0000-0000-000000000014'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.member_email_links
    WHERE id = '98000000-0000-0000-0000-000000000002'
  ) OR v_rollback_assignment_count <> 2 THEN
    RAISE EXCEPTION 'FALHOU remoção: erro deixou revogação parcial';
  END IF;
  RAISE NOTICE 'OK remoção: sucesso revoga aliases e falha desfaz tudo';
END $$;

ROLLBACK;
