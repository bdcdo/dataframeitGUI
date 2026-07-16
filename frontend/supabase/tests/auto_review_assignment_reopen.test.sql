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
  -- Único bloco que depende do estado deixado pelo anterior. Sem este guard,
  -- reordenar os blocos faria a falha acusar a RPC em vez da ordem do arquivo.
  IF NOT EXISTS (
    SELECT 1 FROM public.field_reviews
    WHERE document_id = 'c0000000-0000-0000-0000-000000000001'
      AND self_verdict IS NULL
  ) THEN
    RAISE EXCEPTION
      'pré-condição do cenário quebrou: o bloco anterior não deixou campo pendente';
  END IF;

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

-- ========== Segundo humano não herda fila alheia ==========
-- A UNIQUE de field_reviews é (document_id, field_name) — global, não por
-- humano: só o primeiro que codifica entra na auto-revisão do par (doc, campo).
-- O stub do segundo colide e é descartado; sem o EXISTS governando o INSERT do
-- assignment, ele ganharia uma fila 'pendente' sem nada para revisar.
DO $$
DECLARE
  v_created INTEGER;
  n INTEGER;
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    ('a0000000-0000-0000-0000-000000000002', 'segundo@example.test');
  INSERT INTO public.project_members (project_id, user_id, role) VALUES
    ('b0000000-0000-0000-0000-000000000001',
     'a0000000-0000-0000-0000-000000000002', 'pesquisador');
  INSERT INTO public.responses
    (id, project_id, document_id, respondent_id, respondent_type, answers)
  VALUES
    ('d0000000-0000-0000-0000-000000000003',
     'b0000000-0000-0000-0000-000000000001',
     'c0000000-0000-0000-0000-000000000001',
     'a0000000-0000-0000-0000-000000000002', 'humano', '{"q1":"z","q2":"w"}');

  v_created := public.assign_auto_review_if_eligible(
    'b0000000-0000-0000-0000-000000000001',
    'c0000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000002',
    ARRAY['q1', 'q2'],
    'd0000000-0000-0000-0000-000000000003',
    'd0000000-0000-0000-0000-000000000002'
  );

  IF v_created <> 0 THEN
    RAISE EXCEPTION
      'FALHOU: criou % stub(s) para o segundo humano (a chave é por doc+campo)',
      v_created;
  END IF;

  SELECT count(*) INTO n FROM public.assignments
  WHERE document_id = 'c0000000-0000-0000-0000-000000000001'
    AND user_id = 'a0000000-0000-0000-0000-000000000002'
    AND type = 'auto_revisao';
  IF n <> 0 THEN
    RAISE EXCEPTION
      'FALHOU: segundo humano ganhou fila de auto-revisão sem field_review seu';
  END IF;

  RAISE NOTICE 'OK: segundo humano não entra na fila sem trabalho próprio';
END;
$$;

-- ========== Produtor e fechamento não divergem de chave ==========
-- A serialização depende de os dois lados derivarem a MESMA chave, e nenhum
-- cenário acima enxerga isso: em sessão única a trava nunca bloqueia, então
-- inlinar a chave num dos lados com string ou ordem de parâmetros diferente
-- deixaria a suíte verde e a corrida reaberta. pg_locks expõe a chave tomada.
--
-- O que este bloco NÃO prova: que o sync chega a pegar a trava. Advisory xact
-- lock é reentrante, então a segunda aquisição da mesma chave na mesma
-- transação não cria linha nova em pg_locks — "mesma chave" e "nenhuma trava"
-- são indistinguíveis daqui. O que ele prova é que o sync não pega chave
-- DIVERGENTE (que apareceria como uma segunda linha), que é o modo de falha
-- silencioso. A serialização de fato exige duas sessões e é verificada à mão:
-- produtor segurando a trava em transação aberta + SET lock_timeout no
-- fechamento → 'canceling statement due to lock timeout'.
DO $$
DECLARE
  v_expected BIGINT;
  v_matching INTEGER;
  v_before INTEGER;
  v_mid INTEGER;
  v_after INTEGER;
  -- Tripla própria, que nenhum bloco acima tocou: as travas são xact e
  -- reentrantes, então reusar um par já exercitado esconderia a divergência —
  -- a trava divergente já estaria tomada e o delta daria zero. Com
  -- p_field_names vazio as duas funções só pegam a trava: unnest não produz
  -- linha e o EXISTS não acha pendência, então nada é escrito e nenhuma FK é
  -- tocada (por isso os UUIDs não precisam existir).
  k_project CONSTANT UUID := '0000aaaa-0000-0000-0000-00000000000a';
  k_document CONSTANT UUID := '0000aaaa-0000-0000-0000-00000000000b';
  k_user CONSTANT UUID := '0000aaaa-0000-0000-0000-00000000000c';
BEGIN
  -- Espelha a derivação de lock_auto_review_assignment. Mudar a chave lá exige
  -- mudar aqui — de propósito: a chave é contrato entre os dois lados.
  v_expected := pg_catalog.hashtextextended(
    'auto-review-assignment:'
      || k_project::text || ':' || k_document::text || ':' || k_user::text,
    0
  );

  SELECT count(*) INTO v_before
  FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid();

  PERFORM public.assign_auto_review_if_eligible(
    k_project, k_document, k_user, ARRAY[]::TEXT[], NULL, NULL
  );

  -- A trava é xact: segue segurada até o ROLLBACK final, então dá para
  -- conferi-la aqui. O lock manager parte a chave de 64 bits em classid (32
  -- altos) e objid (32 baixos); comparamos as metades com máscara em vez de
  -- remontar, que estouraria bigint quando o bit alto vem 1.
  SELECT count(*) INTO v_matching
  FROM pg_locks
  WHERE locktype = 'advisory'
    AND pid = pg_backend_pid()
    AND classid::BIGINT = ((v_expected >> 32) & 4294967295)
    AND objid::BIGINT = (v_expected & 4294967295);

  IF v_matching = 0 THEN
    RAISE EXCEPTION
      'FALHOU: assign_auto_review_if_eligible não segura a chave derivada de lock_auto_review_assignment (mudou a derivação?)';
  END IF;

  SELECT count(*) INTO v_mid
  FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid();
  IF v_mid <> v_before + 1 THEN
    RAISE EXCEPTION 'FALHOU: o produtor tomou % travas, esperava 1',
      v_mid - v_before;
  END IF;

  PERFORM public.sync_auto_review_assignment_status(k_project, k_document, k_user);

  SELECT count(*) INTO v_after
  FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid();

  IF v_after <> v_mid THEN
    RAISE EXCEPTION
      'FALHOU: o fechamento tomou uma trava nova (% → %) — chave divergente do produtor',
      v_mid, v_after;
  END IF;

  RAISE NOTICE 'OK: produtor e fechamento não divergem de chave';
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
  v_args TEXT;
  v_entrypoints TEXT[] := ARRAY[
    'public.assign_auto_review_if_eligible(uuid,uuid,uuid,text[],uuid,uuid)',
    'public.sync_auto_review_assignment_status(uuid,uuid,uuid)',
    'public.reopen_auto_review_assignments_with_pending(uuid)'
  ];
  -- supabase.rpc() envia os argumentos por NOME: renomear um parâmetro mantém a
  -- assinatura por tipo intacta (e a suíte verde) enquanto produção quebra com
  -- PGRST202. Estes são os nomes que o TypeScript manda.
  v_expected_args TEXT[] := ARRAY[
    'p_project_id uuid, p_document_id uuid, p_self_reviewer_id uuid, p_field_names text[], p_human_response_id uuid, p_llm_response_id uuid',
    'p_project_id uuid, p_document_id uuid, p_user_id uuid',
    'p_project_id uuid'
  ];
  i INTEGER := 0;
BEGIN
  FOREACH v_fn IN ARRAY v_entrypoints LOOP
    i := i + 1;
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'FALHOU: % alcançável por role de cliente', v_fn;
    END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'FALHOU: % inalcançável pelo backend', v_fn;
    END IF;

    SELECT pg_get_function_arguments(v_fn::regprocedure) INTO v_args;
    IF v_args <> v_expected_args[i] THEN
      RAISE EXCEPTION 'FALHOU: parâmetros de % mudaram: % (esperado %)',
        v_fn, v_args, v_expected_args[i];
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
