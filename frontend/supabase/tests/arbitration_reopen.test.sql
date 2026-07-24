-- Contrato da reabertura da fila de arbitragem (issue #582, migration
-- 20260724110000): assignment 'concluido' reabre quando nova contestação é
-- atribuída ao mesmo árbitro, e o fecho adquire o advisory lock por
-- (project, document). O cenário 4 (caminho de retry) é garantido pela
-- 20260724100100 — este contrato o cobre para que uma redefinição futura de
-- assign_arbitration_cycles_if_eligible não regrida a reabertura de novo.
--
-- field_reviews tem UM ciclo operacional por (document, field_name)
-- (field_reviews_unique); o cenário real da issue é uma contestação de OUTRO
-- campo (ou um ciclo novo do mesmo campo) chegando depois de o árbitro ter
-- concluído o assignment do documento.
--
-- Como rodar (após `npx supabase start` e `npx supabase db reset`):
--   bash scripts/run-sql-test.sh supabase/tests/arbitration_reopen.test.sql
--
-- Validar pelo exit code, não por contar OKs na saída.
-- Roda inteiro em BEGIN ... ROLLBACK; não deixa fixtures no banco local.

BEGIN;

-- ========== Fixtures ==========
-- A codifica e auto-revisa; X é o único membro com can_arbitrate, então a
-- seleção de árbitro é determinística.
INSERT INTO auth.users (id, email) VALUES
  ('82a00000-0000-0000-0000-000000000001', 'coder-a-582@example.test'),
  ('82a00000-0000-0000-0000-000000000003', 'arbitro-x-582@example.test');

INSERT INTO public.clerk_user_mapping
  (clerk_user_id, supabase_user_id, access_sync_version)
SELECT id::text, id, 1
FROM auth.users
WHERE id::text LIKE '82a00000-0000-0000-0000-%';

INSERT INTO public.projects (id, name, created_by, pydantic_fields) VALUES
  ('82b00000-0000-0000-0000-000000000001', 'arbitration reopen #582',
   '82a00000-0000-0000-0000-000000000001',
   '[{"name":"q1"},{"name":"q2"},{"name":"q3"}]');

INSERT INTO public.documents (id, project_id, title, text, text_hash) VALUES
  ('82c00000-0000-0000-0000-000000000001',
   '82b00000-0000-0000-0000-000000000001', 'doc', 'texto', 'h-582');

INSERT INTO public.project_members (project_id, user_id, role, can_arbitrate)
VALUES
  ('82b00000-0000-0000-0000-000000000001',
   '82a00000-0000-0000-0000-000000000001', 'pesquisador', false),
  ('82b00000-0000-0000-0000-000000000001',
   '82a00000-0000-0000-0000-000000000003', 'pesquisador', true);

INSERT INTO public.responses
  (id, project_id, document_id, respondent_id, respondent_type, answers)
VALUES
  ('82d00000-0000-0000-0000-000000000001', '82b00000-0000-0000-0000-000000000001',
   '82c00000-0000-0000-0000-000000000001', '82a00000-0000-0000-0000-000000000001',
   'humano', '{"q1":"a","q2":"a","q3":"a"}'),
  ('82d00000-0000-0000-0000-000000000003', '82b00000-0000-0000-0000-000000000001',
   '82c00000-0000-0000-0000-000000000001', NULL,
   'llm', '{"q1":"llm","q2":"llm","q3":"llm"}');

-- fr1 (q1): contestação já arbitrada por X na fase blind — é o ciclo que X
-- vai fechar. fr2 (q2): auto-revisão ainda sem veredito próprio.
INSERT INTO public.field_reviews
  (id, project_id, document_id, field_name, human_response_id, llm_response_id,
   self_reviewer_id, self_verdict, self_reviewed_at, self_justification,
   arbitrator_id, blind_verdict, blind_decided_at)
VALUES
  ('82f00000-0000-0000-0000-000000000001', '82b00000-0000-0000-0000-000000000001',
   '82c00000-0000-0000-0000-000000000001', 'q1',
   '82d00000-0000-0000-0000-000000000001', '82d00000-0000-0000-0000-000000000003',
   '82a00000-0000-0000-0000-000000000001', 'contesta_llm', now(), 'difere',
   '82a00000-0000-0000-0000-000000000003', 'humano', now()),
  ('82f00000-0000-0000-0000-000000000002', '82b00000-0000-0000-0000-000000000001',
   '82c00000-0000-0000-0000-000000000001', 'q2',
   '82d00000-0000-0000-0000-000000000001', '82d00000-0000-0000-0000-000000000003',
   '82a00000-0000-0000-0000-000000000001', NULL, NULL, NULL,
   NULL, NULL, NULL);

INSERT INTO public.assignments (id, project_id, document_id, user_id, type, status)
VALUES
  ('82e00000-0000-0000-0000-000000000001', '82b00000-0000-0000-0000-000000000001',
   '82c00000-0000-0000-0000-000000000001', '82a00000-0000-0000-0000-000000000003',
   'arbitragem', 'pendente'),
  ('82e00000-0000-0000-0000-000000000002', '82b00000-0000-0000-0000-000000000001',
   '82c00000-0000-0000-0000-000000000001', '82a00000-0000-0000-0000-000000000001',
   'auto_revisao', 'pendente');

-- ========== 1. Fecho da arbitragem adquire o advisory lock e conclui ==========
SELECT public.submit_final_review_verdicts(
  '82b00000-0000-0000-0000-000000000001',
  '82c00000-0000-0000-0000-000000000001',
  '82a00000-0000-0000-0000-000000000003',
  '[{"field_review_id":"82f00000-0000-0000-0000-000000000001",
     "field_name":"q1","verdict":"humano"}]'::jsonb
);

DO $$
DECLARE
  v_key TEXT;
  v_hash BIGINT;
BEGIN
  IF (SELECT status FROM public.assignments
      WHERE id = '82e00000-0000-0000-0000-000000000001') <> 'concluido' THEN
    RAISE EXCEPTION 'FALHOU: fecho não concluiu o assignment de arbitragem';
  END IF;
  -- O lock é xact-scoped: dentro desta transação ele ainda aparece em
  -- pg_locks. Os locks são identificados pela CHAVE (classid = 32 bits altos
  -- do hash, objid = 32 bits baixos) e não por existência, porque outros
  -- triggers da transação seguram advisory locks próprios.
  --
  -- São DUAS chaves porque há dois criadores de contestação com quem o fecho
  -- precisa excluir-se mutuamente (ver o comentário na migration):
  --   1. submit_auto_review_verdicts    -> 'project:document'
  --   2. assign_arbitration_cycles_if_eligible (retry, via
  --      lock_arbitration_assignment) -> 'arbitration-assignment:p:d:user'
  -- Faltando qualquer uma, a corrida da #582 volta por aquele caminho.
  FOREACH v_key IN ARRAY ARRAY[
    '82b00000-0000-0000-0000-000000000001:82c00000-0000-0000-0000-000000000001',
    'arbitration-assignment:82b00000-0000-0000-0000-000000000001'
      || ':82c00000-0000-0000-0000-000000000001'
      || ':82a00000-0000-0000-0000-000000000003'
  ]
  LOOP
    v_hash := hashtextextended(v_key, 0);
    -- O `& 4294967295` nos DOIS campos não é decorativo: hashtextextended
    -- devolve bigint COM SINAL e pg_locks guarda classid/objid como uint32.
    -- Para hash negativo, `>> 32` propaga o sinal e o cast estoura com "OID
    -- out of range" — a asserção morreria com erro em vez de comparar. A chave
    -- 'arbitration-assignment:...' cai justamente nesse caso.
    IF NOT EXISTS (
      SELECT 1 FROM pg_locks
      WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
        AND classid = ((v_hash >> 32) & 4294967295)::oid
        AND objid = (v_hash & 4294967295)::oid
    ) THEN
      RAISE EXCEPTION
        'FALHOU: submit_final_review_verdicts não adquiriu o advisory lock da chave %',
        v_key;
    END IF;
  END LOOP;
  RAISE NOTICE 'OK 1: fecho conclui o assignment sob os dois advisory locks';
END $$;

-- ========== 2. Nova contestação REABRE o assignment concluído ==========
-- É o cenário da issue #582: A contesta outro campo depois de X ter
-- concluído; X é o único elegível e é reescolhido. Na versão outbox
-- (DO NOTHING) o assignment fica 'concluido' e a contestação nunca aparece
-- na fila de X (a página filtra status <> 'concluido').
SELECT public.submit_auto_review_verdicts(
  '82b00000-0000-0000-0000-000000000001',
  '82c00000-0000-0000-0000-000000000001',
  '82a00000-0000-0000-0000-000000000001',
  '[{"field_review_id":"82f00000-0000-0000-0000-000000000002",
     "field_name":"q2","verdict":"contesta_llm","justification":"difere do llm"}]'::jsonb
);

DO $$
DECLARE
  v_assignment public.assignments%ROWTYPE;
BEGIN
  IF (SELECT arbitrator_id FROM public.field_reviews
      WHERE id = '82f00000-0000-0000-0000-000000000002')
     IS DISTINCT FROM '82a00000-0000-0000-0000-000000000003'::uuid THEN
    RAISE EXCEPTION 'FALHOU: contestação não foi atribuída ao árbitro X';
  END IF;
  SELECT * INTO v_assignment FROM public.assignments
  WHERE id = '82e00000-0000-0000-0000-000000000001';
  IF v_assignment.status <> 'pendente' OR v_assignment.completed_at IS NOT NULL THEN
    RAISE EXCEPTION
      'FALHOU: assignment de arbitragem não reabriu (status=%, completed_at=%)',
      v_assignment.status, v_assignment.completed_at;
  END IF;
  RAISE NOTICE 'OK 2: nova contestação reabre o assignment concluído';
END $$;

-- ========== 3. Guarda preservada: veredito llm exige sugestão ==========
-- A redefinição copiou o corpo do outbox; este contrato fixa que a guarda
-- não evaporou na cópia (lição do #557: reescrita de RPC dropa guardas).
UPDATE public.field_reviews
SET blind_verdict = 'humano', blind_decided_at = now()
WHERE id = '82f00000-0000-0000-0000-000000000002';

DO $$
BEGIN
  BEGIN
    PERFORM public.submit_final_review_verdicts(
      '82b00000-0000-0000-0000-000000000001',
      '82c00000-0000-0000-0000-000000000001',
      '82a00000-0000-0000-0000-000000000003',
      '[{"field_review_id":"82f00000-0000-0000-0000-000000000002",
         "field_name":"q2","verdict":"llm"}]'::jsonb
    );
    RAISE EXCEPTION 'FALHOU: veredito llm sem sugestão deveria ser rejeitado';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM LIKE 'FALHOU:%' THEN
        RAISE;
      END IF;
      RAISE NOTICE 'OK 3: veredito llm sem sugestão segue rejeitado (%)', SQLERRM;
  END;
END $$;

-- ========== 4. retry (assign_arbitration_cycles_if_eligible) também reabre ==========
INSERT INTO public.field_reviews
  (id, project_id, document_id, field_name, human_response_id, llm_response_id,
   self_reviewer_id, self_verdict, self_reviewed_at, self_justification)
VALUES
  ('82f00000-0000-0000-0000-000000000003', '82b00000-0000-0000-0000-000000000001',
   '82c00000-0000-0000-0000-000000000001', 'q3',
   '82d00000-0000-0000-0000-000000000001', '82d00000-0000-0000-0000-000000000003',
   '82a00000-0000-0000-0000-000000000001', 'contesta_llm', now(), 'difere q3');

UPDATE public.assignments
SET status = 'concluido', completed_at = now()
WHERE id = '82e00000-0000-0000-0000-000000000001';

DO $$
DECLARE
  v_assigned INTEGER;
BEGIN
  SELECT public.assign_arbitration_cycles_if_eligible(
    '82b00000-0000-0000-0000-000000000001',
    '82c00000-0000-0000-0000-000000000001',
    '82a00000-0000-0000-0000-000000000003',
    ARRAY['82f00000-0000-0000-0000-000000000003']::uuid[]
  ) INTO v_assigned;
  IF v_assigned <> 1 THEN
    RAISE EXCEPTION 'FALHOU: retry não atribuiu a contestação (assigned=%)', v_assigned;
  END IF;
  IF (SELECT status FROM public.assignments
      WHERE id = '82e00000-0000-0000-0000-000000000001') <> 'pendente' THEN
    RAISE EXCEPTION 'FALHOU: retry não reabriu o assignment concluído';
  END IF;
  RAISE NOTICE 'OK 4: retry de arbitragem reabre o assignment concluído';
END $$;

-- ========== 5. Fecho volta a concluir quando tudo é decidido ==========
UPDATE public.field_reviews
SET blind_verdict = 'humano', blind_decided_at = now()
WHERE id = '82f00000-0000-0000-0000-000000000003';

SELECT public.submit_final_review_verdicts(
  '82b00000-0000-0000-0000-000000000001',
  '82c00000-0000-0000-0000-000000000001',
  '82a00000-0000-0000-0000-000000000003',
  '[{"field_review_id":"82f00000-0000-0000-0000-000000000002",
     "field_name":"q2","verdict":"humano"},
    {"field_review_id":"82f00000-0000-0000-0000-000000000003",
     "field_name":"q3","verdict":"humano"}]'::jsonb
);

DO $$
BEGIN
  IF (SELECT status FROM public.assignments
      WHERE id = '82e00000-0000-0000-0000-000000000001') <> 'concluido' THEN
    RAISE EXCEPTION 'FALHOU: fecho não concluiu após todos os vereditos';
  END IF;
  RAISE NOTICE 'OK 5: fecho conclui quando não resta contestação pendente';
END $$;

ROLLBACK;
