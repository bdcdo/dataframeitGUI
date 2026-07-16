-- Regressão do fechamento da fila de auto-revisão (PR #440, issue #416).
--
-- Como rodar após `npx supabase db reset`:
--   docker exec -i supabase_db_frontend psql -U postgres -d postgres \
--     -X -v ON_ERROR_STOP=1 < supabase/tests/auto_review_assignment_sync.test.sql
-- Sucesso = nenhuma exceção e os NOTICE "OK ..." no final. Qualquer FALHOU aborta.
--
-- A regra do envio parcial (só fecha quando nenhum campo fica sem veredito)
-- vivia na action, em SELECT→UPDATE separados; aqui ela é verificada onde
-- passou a morar: dentro da RPC, resolvida sob lock num único statement.
-- Roda inteiro em BEGIN ... ROLLBACK.

BEGIN;

-- ========== Fixtures ==========
INSERT INTO auth.users (id, email) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'canonical@example.test'),
  ('a0000000-0000-0000-0000-000000000002', 'alias@example.test'),
  ('a0000000-0000-0000-0000-000000000003', 'outsider@example.test');

INSERT INTO public.clerk_user_mapping
  (clerk_user_id, supabase_user_id, access_sync_version)
SELECT id::text, id, 1
FROM auth.users
WHERE id::text LIKE 'a0000000-0000-0000-0000-%';

INSERT INTO public.projects (id, name, created_by) VALUES
  ('b0000000-0000-0000-0000-000000000001', 'auto review sync',
   'a0000000-0000-0000-0000-000000000001');

INSERT INTO public.documents (id, project_id, title, text, text_hash) VALUES
  ('c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001',
   'doc', 'texto', 'h-doc');

INSERT INTO public.project_members (project_id, user_id, role) VALUES
  ('b0000000-0000-0000-0000-000000000001',
   'a0000000-0000-0000-0000-000000000001', 'pesquisador');

-- A conta-alias resolve para o membro canônico e não tem membership própria:
-- é exatamente a configuração da issue #416.
INSERT INTO public.member_email_links
  (project_id, member_user_id, email, linked_user_id, created_by)
VALUES
  ('b0000000-0000-0000-0000-000000000001',
   'a0000000-0000-0000-0000-000000000001', 'alias@example.test',
   'a0000000-0000-0000-0000-000000000002',
   'a0000000-0000-0000-0000-000000000001');

INSERT INTO public.responses
  (id, project_id, document_id, respondent_id, respondent_type, answers)
VALUES
  ('d0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001',
   'c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
   'humano', '{"q1":"x","q2":"y"}'),
  ('d0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000001',
   'c0000000-0000-0000-0000-000000000001', NULL, 'llm', '{"q1":"z","q2":"w"}');

INSERT INTO public.assignments (id, project_id, document_id, user_id, type, status)
VALUES
  ('e0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001',
   'c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
   'auto_revisao', 'pendente');

-- q1 já resolvido, q2 ainda pendente.
INSERT INTO public.field_reviews
  (id, project_id, document_id, field_name, human_response_id, llm_response_id,
   self_reviewer_id, self_verdict, self_reviewed_at)
VALUES
  ('f0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001',
   'c0000000-0000-0000-0000-000000000001', 'q1',
   'd0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000002',
   'a0000000-0000-0000-0000-000000000001', 'admite_erro', now()),
  ('f0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000001',
   'c0000000-0000-0000-0000-000000000001', 'q2',
   'd0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000002',
   'a0000000-0000-0000-0000-000000000001', NULL, NULL);

GRANT SELECT ON public.assignments, public.field_reviews TO authenticated;

-- ========== Envio parcial não tira o documento da fila ==========
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a0000000-0000-0000-0000-000000000001",'
    || '"supabase_uid":"a0000000-0000-0000-0000-000000000001"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  closed BOOLEAN;
  current_status TEXT;
BEGIN
  closed := public.sync_auto_review_assignment_status(
    'b0000000-0000-0000-0000-000000000001',
    'c0000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000001'
  );
  IF closed THEN
    RAISE EXCEPTION 'FALHOU envio parcial: fechou com q2 sem veredito';
  END IF;

  SELECT status INTO current_status FROM public.assignments
  WHERE id = 'e0000000-0000-0000-0000-000000000001';
  IF current_status = 'concluido' THEN
    RAISE EXCEPTION 'FALHOU envio parcial: assignment saiu da fila';
  END IF;

  RAISE NOTICE 'OK: campo pendente mantém o documento na fila';
END;
$$;

-- ========== Autorização: identidade alheia não fecha a fila ==========
RESET ROLE;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a0000000-0000-0000-0000-000000000003",'
    || '"supabase_uid":"a0000000-0000-0000-0000-000000000003"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  closed BOOLEAN;
BEGIN
  -- A RPC é SECURITY DEFINER: sem o gate explícito, um estranho fecharia a fila
  -- de qualquer pesquisador passando o UUID dele.
  BEGIN
    closed := public.sync_auto_review_assignment_status(
      'b0000000-0000-0000-0000-000000000001',
      'c0000000-0000-0000-0000-000000000001',
      'a0000000-0000-0000-0000-000000000001'
    );
    RAISE EXCEPTION 'FALHOU autorização: não-membro sincronizou fila alheia';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'OK: identidade alheia recusada';
  END;
END;
$$;

-- ========== Conta-alias fecha a fila do membro canônico ==========
RESET ROLE;
-- As claims do bloco anterior sobrevivem na transação: sem limpá-las,
-- enforce_field_review_phase_transition leria o outsider como ator do UPDATE de
-- fixture abaixo. Sem JWT, clerk_uid() é NULL e a escrita conta como interna.
SELECT set_config('request.jwt.claims', '', true);

UPDATE public.field_reviews
  SET self_verdict = 'contesta_llm', self_reviewed_at = now()
  WHERE id = 'f0000000-0000-0000-0000-000000000002';

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a0000000-0000-0000-0000-000000000002",'
    || '"supabase_uid":"a0000000-0000-0000-0000-000000000002"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  closed BOOLEAN;
  current_status TEXT;
BEGIN
  -- O alias não é project_member; quem autoriza é a identidade canônica dele.
  closed := public.sync_auto_review_assignment_status(
    'b0000000-0000-0000-0000-000000000001',
    'c0000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000001'
  );
  IF NOT closed THEN
    RAISE EXCEPTION 'FALHOU alias: não fechou a fila do membro canônico';
  END IF;

  SELECT status INTO current_status FROM public.assignments
  WHERE id = 'e0000000-0000-0000-0000-000000000001';
  IF current_status <> 'concluido' THEN
    RAISE EXCEPTION 'FALHOU alias: assignment ficou em %', current_status;
  END IF;

  RAISE NOTICE 'OK: alias fecha a fila canônica quando nada fica pendente';
END;
$$;

-- ========== Reabertura: trabalho novo devolve o documento à fila ==========
RESET ROLE;
SELECT set_config('request.jwt.claims', '', true);

DO $$
DECLARE
  v_created INTEGER;
  current_status TEXT;
BEGIN
  -- Estado de partida: assignment concluído (o bloco anterior fechou a fila).
  SELECT status INTO current_status FROM public.assignments
  WHERE id = 'e0000000-0000-0000-0000-000000000001';
  IF current_status <> 'concluido' THEN
    RAISE EXCEPTION 'fixture: assignment deveria estar concluido, está %',
      current_status;
  END IF;

  -- O pesquisador edita a codificação e um campo novo passa a divergir. Antes,
  -- o upsert com ignoreDuplicates criava o stub e deixava o assignment
  -- concluído: documento fora da fila com veredito por fazer.
  v_created := public.assign_auto_review_if_eligible(
    'b0000000-0000-0000-0000-000000000001',
    'c0000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000001',
    ARRAY['q3'],
    'd0000000-0000-0000-0000-000000000001',
    'd0000000-0000-0000-0000-000000000002'
  );

  IF v_created <> 1 THEN
    RAISE EXCEPTION 'FALHOU reabertura: esperava 1 stub novo, criou %', v_created;
  END IF;

  SELECT status INTO current_status FROM public.assignments
  WHERE id = 'e0000000-0000-0000-0000-000000000001';
  IF current_status <> 'pendente' THEN
    RAISE EXCEPTION
      'FALHOU reabertura: campo pendente novo não devolveu o doc à fila (status=%)',
      current_status;
  END IF;

  RAISE NOTICE 'OK: trabalho novo reabre o assignment concluído';
END;
$$;

-- ========== Idempotência: sem stub novo, não reabre fila já fechada ==========
DO $$
DECLARE
  v_created INTEGER;
  current_status TEXT;
BEGIN
  -- Fecha tudo de novo.
  UPDATE public.field_reviews
    SET self_verdict = 'admite_erro', self_reviewed_at = now()
    WHERE project_id = 'b0000000-0000-0000-0000-000000000001'
      AND self_verdict IS NULL;
  UPDATE public.assignments SET status = 'concluido', completed_at = now()
    WHERE id = 'e0000000-0000-0000-0000-000000000001';

  -- Reexecução com os mesmos campos: os stubs já existem, nada fica pendente.
  v_created := public.assign_auto_review_if_eligible(
    'b0000000-0000-0000-0000-000000000001',
    'c0000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000001',
    ARRAY['q1', 'q2', 'q3'],
    'd0000000-0000-0000-0000-000000000001',
    'd0000000-0000-0000-0000-000000000002'
  );

  IF v_created <> 0 THEN
    RAISE EXCEPTION 'FALHOU idempotência: recriou % stub(s)', v_created;
  END IF;

  SELECT status INTO current_status FROM public.assignments
  WHERE id = 'e0000000-0000-0000-0000-000000000001';
  IF current_status <> 'concluido' THEN
    RAISE EXCEPTION
      'FALHOU idempotência: reabriu fila sem trabalho pendente (status=%)',
      current_status;
  END IF;

  RAISE NOTICE 'OK: reexecução sem trabalho novo não reabre a fila';
END;
$$;

-- ========== Reconciliação em lote do backlog ==========
DO $$
DECLARE
  v_reopened INTEGER;
  current_status TEXT;
BEGIN
  -- Simula o que a regeneração manual produzia: field_review pendente devolvido
  -- ao backlog enquanto o assignment seguia concluído.
  UPDATE public.field_reviews
    SET self_verdict = NULL, self_reviewed_at = NULL
    WHERE id = 'f0000000-0000-0000-0000-000000000002';

  v_reopened := public.reopen_auto_review_assignments_with_pending(
    'b0000000-0000-0000-0000-000000000001'
  );

  IF v_reopened <> 1 THEN
    RAISE EXCEPTION 'FALHOU backlog: reabriu % assignment(s)', v_reopened;
  END IF;

  SELECT status INTO current_status FROM public.assignments
  WHERE id = 'e0000000-0000-0000-0000-000000000001';
  IF current_status <> 'pendente' THEN
    RAISE EXCEPTION 'FALHOU backlog: assignment ficou em %', current_status;
  END IF;

  RAISE NOTICE 'OK: backlog reconcilia assignment fechado com campo pendente';
END;
$$;

RESET ROLE;
ROLLBACK;
