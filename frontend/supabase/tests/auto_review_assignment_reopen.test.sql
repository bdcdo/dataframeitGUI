-- Regressão da reabertura da fila de auto-revisão.
--
-- Como rodar após `npx supabase db reset`:
--   docker exec -i supabase_db_frontend psql -U postgres -d postgres \
--     -X -v ON_ERROR_STOP=1 < supabase/tests/auto_review_assignment_reopen.test.sql
-- Sucesso = nenhuma exceção e os NOTICE "OK ..." no final. Qualquer FALHOU aborta.
--
-- O upsert com ignoreDuplicates nunca devolve um assignment concluído para
-- 'pendente': trabalho novo num documento já revisado ficava preso fora da
-- fila. As funções exercidas aqui rodam como service_role (é o backend que
-- cria a auto-revisão), então nenhum bloco troca de role. BEGIN ... ROLLBACK.

BEGIN;

-- ========== Fixtures: fila já concluída ==========
INSERT INTO auth.users (id, email) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'pesquisador@example.test');

INSERT INTO public.projects (id, name, created_by) VALUES
  ('b0000000-0000-0000-0000-000000000001', 'auto review reopen',
   'a0000000-0000-0000-0000-000000000001');

INSERT INTO public.documents (id, project_id, title, text, text_hash) VALUES
  ('c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001',
   'doc', 'texto', 'h-doc');

INSERT INTO public.project_members (project_id, user_id, role) VALUES
  ('b0000000-0000-0000-0000-000000000001',
   'a0000000-0000-0000-0000-000000000001', 'pesquisador');

INSERT INTO public.responses
  (id, project_id, document_id, respondent_id, respondent_type, answers)
VALUES
  ('d0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001',
   'c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
   'humano', '{"q1":"x","q2":"y"}'),
  ('d0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000001',
   'c0000000-0000-0000-0000-000000000001', NULL, 'llm', '{"q1":"a","q2":"b"}');

-- O pesquisador já revisou o que divergia e a fila fechou.
INSERT INTO public.assignments
  (id, project_id, document_id, user_id, type, status, completed_at)
VALUES
  ('e0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001',
   'c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
   'auto_revisao', 'concluido', now());

INSERT INTO public.field_reviews
  (id, project_id, document_id, field_name, human_response_id, llm_response_id,
   self_reviewer_id, self_verdict, self_reviewed_at)
VALUES
  ('f0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001',
   'c0000000-0000-0000-0000-000000000001', 'q1',
   'd0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000002',
   'a0000000-0000-0000-0000-000000000001', 'admite_erro', now());

-- ========== Trabalho novo devolve o documento à fila ==========
DO $$
DECLARE
  v_created INTEGER;
  current_status TEXT;
BEGIN
  -- O pesquisador edita a codificação e q2 passa a divergir do LLM. Antes, o
  -- stub nascia pendente e o assignment continuava 'concluido' — documento fora
  -- da fila com veredito por fazer, sem volta.
  v_created := public.assign_auto_review_if_eligible(
    'b0000000-0000-0000-0000-000000000001',
    'c0000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000001',
    ARRAY['q2'],
    'd0000000-0000-0000-0000-000000000001',
    'd0000000-0000-0000-0000-000000000002'
  );

  IF v_created <> 1 THEN
    RAISE EXCEPTION 'FALHOU: esperava 1 stub novo, criou %', v_created;
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

-- ========== Reexecução não recria stub nem apaga veredito ==========
DO $$
DECLARE
  v_created INTEGER;
  n INTEGER;
BEGIN
  -- A auto-revisão dispara a cada submit de codificação, então reexecutar com
  -- os mesmos campos é o caso comum, não a exceção.
  v_created := public.assign_auto_review_if_eligible(
    'b0000000-0000-0000-0000-000000000001',
    'c0000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000001',
    ARRAY['q1', 'q2'],
    'd0000000-0000-0000-0000-000000000001',
    'd0000000-0000-0000-0000-000000000002'
  );

  IF v_created <> 0 THEN
    RAISE EXCEPTION 'FALHOU idempotência: recriou % stub(s)', v_created;
  END IF;

  SELECT count(*) INTO n FROM public.field_reviews
  WHERE document_id = 'c0000000-0000-0000-0000-000000000001';
  IF n <> 2 THEN
    RAISE EXCEPTION 'FALHOU idempotência: % field_reviews (esperava 2)', n;
  END IF;

  SELECT count(*) INTO n FROM public.field_reviews
  WHERE id = 'f0000000-0000-0000-0000-000000000001'
    AND self_verdict = 'admite_erro';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALHOU idempotência: veredito existente foi sobrescrito';
  END IF;

  RAISE NOTICE 'OK: reexecução não recria stub nem apaga veredito';
END;
$$;

-- ========== Fila sem pendência permanece fechada ==========
DO $$
DECLARE
  v_created INTEGER;
  current_status TEXT;
BEGIN
  UPDATE public.field_reviews
    SET self_verdict = 'admite_erro', self_reviewed_at = now()
    WHERE document_id = 'c0000000-0000-0000-0000-000000000001'
      AND self_verdict IS NULL;
  UPDATE public.assignments SET status = 'concluido', completed_at = now()
    WHERE id = 'e0000000-0000-0000-0000-000000000001';

  v_created := public.assign_auto_review_if_eligible(
    'b0000000-0000-0000-0000-000000000001',
    'c0000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000001',
    ARRAY['q1', 'q2'],
    'd0000000-0000-0000-0000-000000000001',
    'd0000000-0000-0000-0000-000000000002'
  );

  IF v_created <> 0 THEN
    RAISE EXCEPTION 'FALHOU: criou stub para campo já resolvido';
  END IF;

  SELECT status INTO current_status FROM public.assignments
  WHERE id = 'e0000000-0000-0000-0000-000000000001';
  IF current_status <> 'concluido' THEN
    RAISE EXCEPTION
      'FALHOU: reabriu fila sem trabalho pendente (status=%)', current_status;
  END IF;

  RAISE NOTICE 'OK: fila sem pendência permanece fechada';
END;
$$;

-- ========== Reconciliação em lote do backlog ==========
DO $$
DECLARE
  v_reopened INTEGER;
  current_status TEXT;
BEGIN
  -- Simula o que a regeneração manual produzia: field_review devolvido ao
  -- backlog enquanto o assignment seguia concluído.
  UPDATE public.field_reviews
    SET self_verdict = NULL, self_reviewed_at = NULL
    WHERE id = 'f0000000-0000-0000-0000-000000000001';

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

  v_reopened := public.reopen_auto_review_assignments_with_pending(
    'b0000000-0000-0000-0000-000000000001'
  );
  IF v_reopened <> 0 THEN
    RAISE EXCEPTION 'FALHOU backlog: reabriu % assignment(s) já pendentes',
      v_reopened;
  END IF;

  RAISE NOTICE 'OK: backlog reconcilia fila fechada com campo pendente';
END;
$$;

-- ========== Fechamento: o outro lado do par ==========
-- Estado herdado do bloco anterior: q1 pendente de novo, q2 já resolvido,
-- assignment reaberto. O envio é parcial, então enquanto q1 não tiver veredito o
-- documento continua na fila.
DO $$
DECLARE
  v_closed BOOLEAN;
  current_status TEXT;
BEGIN
  v_closed := public.sync_auto_review_assignment_status(
    'b0000000-0000-0000-0000-000000000001',
    'c0000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000001'
  );

  IF v_closed THEN
    RAISE EXCEPTION 'FALHOU: fechou a fila com campo pendente vivo';
  END IF;

  SELECT status INTO current_status FROM public.assignments
  WHERE id = 'e0000000-0000-0000-0000-000000000001';
  IF current_status <> 'pendente' THEN
    RAISE EXCEPTION 'FALHOU: envio parcial tirou o doc da fila (status=%)',
      current_status;
  END IF;

  -- O pesquisador resolve o que faltava: agora sim a fila fecha.
  UPDATE public.field_reviews
    SET self_verdict = 'admite_erro', self_reviewed_at = now()
    WHERE id = 'f0000000-0000-0000-0000-000000000001';

  v_closed := public.sync_auto_review_assignment_status(
    'b0000000-0000-0000-0000-000000000001',
    'c0000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000001'
  );

  IF NOT v_closed THEN
    RAISE EXCEPTION 'FALHOU: fila sem pendência não fechou';
  END IF;

  SELECT status INTO current_status FROM public.assignments
  WHERE id = 'e0000000-0000-0000-0000-000000000001';
  IF current_status <> 'concluido' THEN
    RAISE EXCEPTION 'FALHOU: assignment ficou em % após resolver tudo',
      current_status;
  END IF;

  RAISE NOTICE 'OK: envio parcial mantém o doc na fila; completo fecha';
END;
$$;

-- ========== Grants ==========
-- Quem cria e quem fecha a auto-revisão é o backend, e a trava não é chamável
-- por role de runtime nenhum: os dois entrypoints são SECURITY DEFINER e rodam
-- como owner. Sem estas asserções o REVOKE quebraria em silêncio — as default
-- privileges do schema public dão EXECUTE a anon/authenticated/service_role por
-- omissão em toda função nova.
DO $$
DECLARE
  v_fn TEXT;
  v_entrypoints TEXT[] := ARRAY[
    'public.assign_auto_review_if_eligible(uuid,uuid,uuid,text[],uuid,uuid)',
    'public.sync_auto_review_assignment_status(uuid,uuid,uuid)',
    'public.reopen_auto_review_assignments_with_pending(uuid)'
  ];
BEGIN
  FOREACH v_fn IN ARRAY v_entrypoints LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'FALHOU: % alcançável por role de cliente', v_fn;
    END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'FALHOU: % inalcançável pelo backend', v_fn;
    END IF;
  END LOOP;

  FOREACH v_fn IN ARRAY ARRAY[
    'public.lock_auto_review_assignment(uuid,uuid,uuid)'
  ] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION
        'FALHOU: % chamável avulsa — uma sessão poderia segurar a fila alheia',
        v_fn;
    END IF;
  END LOOP;

  RAISE NOTICE 'OK: entrypoints service_role-only e trava fora de alcance';
END;
$$;

ROLLBACK;
