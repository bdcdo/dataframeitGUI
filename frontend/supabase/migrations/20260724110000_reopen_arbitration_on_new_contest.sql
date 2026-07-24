-- Reabre a fila de arbitragem quando nova contestação chega a árbitro que já
-- concluiu o assignment do documento (issue #582).
--
-- Regressão introduzida pelo outbox (20260717120000): os dois sites que criam
-- assignment de 'arbitragem' trocaram o ON CONFLICT DO UPDATE de reabertura
-- (20260716160100) por DO NOTHING — a fila 'auto_revisao' da mesma migration
-- manteve o DO UPDATE. Um assignment 'concluido' nunca voltava a 'pendente',
-- e a página de arbitragem (filtro status <> 'concluido') nunca carregava o
-- field_review pendente: revisão gravada, mas invisível.
--
-- As duas funções abaixo são cópias byte a byte do outbox, mudando apenas:
--   1. submit_auto_review_verdicts: ON CONFLICT ... DO NOTHING  ->  DO UPDATE
--      SET status='pendente', completed_at=NULL WHERE
--      assignments.status='concluido' (espelho da fila auto_revisao).
--   2. submit_final_review_verdicts: adquire os advisory locks dos DOIS
--      criadores de contestação, serializando o fecho da arbitragem com a
--      atribuição de nova arbitragem por qualquer caminho (ver o comentário
--      no corpo da função).
--
-- O terceiro site (assign_arbitration_cycles_if_eligible) já foi reaberto —
-- com as guardas restauradas — pela 20260724100100; não o redefinimos aqui
-- para não reverter aquelas guardas (lição do #557).
--
-- Não filtramos superseded_at no NOT EXISTS do fecho: na tabela operacional o
-- estado "contestado superseded" é inconstruível (snapshot_field_review_cycle
-- zera superseded_at em todo INSERT; ciclos anteriores vivem em
-- field_review_cycle_history_entries), então o filtro seria guarda morta.

CREATE OR REPLACE FUNCTION public.submit_auto_review_verdicts(
  p_project_id UUID,
  p_document_id UUID,
  p_reviewer_id UUID,
  p_rows JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row JSONB;
  v_review public.field_reviews%ROWTYPE;
  v_verdict TEXT;
  v_justification TEXT;
  v_contested_ids UUID[] := ARRAY[]::UUID[];
  v_arbitrator_id UUID;
  v_arbitrated INTEGER := 0;
BEGIN
  IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array'
     OR pg_catalog.jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'p_rows must be a non-empty JSON array';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_project_id::TEXT || ':' || p_document_id::TEXT,
      0
    )
  );

  IF (SELECT count(*) FROM pg_catalog.jsonb_array_elements(p_rows)) <>
     (SELECT count(DISTINCT row->>'field_review_id')
      FROM pg_catalog.jsonb_array_elements(p_rows) AS rows(row)) THEN
    RAISE EXCEPTION 'field_review_id must be unique within p_rows';
  END IF;

  FOR v_row IN SELECT row FROM pg_catalog.jsonb_array_elements(p_rows) AS rows(row)
  LOOP
    SELECT * INTO v_review
    FROM public.field_reviews AS review
    WHERE review.id = (v_row->>'field_review_id')::UUID
      AND review.project_id = p_project_id
      AND review.document_id = p_document_id
      AND review.field_name = v_row->>'field_name'
      AND review.self_reviewer_id = p_reviewer_id
      AND review.superseded_at IS NULL
    FOR UPDATE;

    IF v_review.id IS NULL THEN
      RAISE EXCEPTION 'review cycle is missing, superseded, or incompatible';
    END IF;

    v_verdict := v_row->>'verdict';
    v_justification := NULLIF(pg_catalog.btrim(v_row->>'justification'), '');
    IF v_verdict NOT IN ('admite_erro', 'contesta_llm', 'equivalente', 'ambiguo')
       OR (v_verdict IN ('contesta_llm', 'ambiguo') AND v_justification IS NULL)
       OR (v_review.self_verdict IS NOT NULL AND v_review.self_verdict <> v_verdict) THEN
      RAISE EXCEPTION 'invalid or conflicting self-review verdict';
    END IF;

    IF v_review.self_verdict IS NULL THEN
      UPDATE public.field_reviews
      SET self_verdict = v_verdict,
          self_reviewed_at = pg_catalog.now(),
          self_justification = CASE
            WHEN v_verdict IN ('contesta_llm', 'ambiguo') THEN v_justification
            ELSE NULL
          END
      WHERE id = v_review.id;
    END IF;

    IF v_verdict = 'equivalente' THEN
      INSERT INTO public.response_equivalences (
        project_id, document_id, field_name,
        response_a_id, response_b_id, reviewer_id
      ) VALUES (
        p_project_id, p_document_id, v_review.field_name,
        LEAST(v_review.human_response_id, v_review.llm_response_id),
        GREATEST(v_review.human_response_id, v_review.llm_response_id),
        p_reviewer_id
      ) ON CONFLICT (
        project_id, document_id, field_name, response_a_id, response_b_id
      ) DO NOTHING;
    ELSIF v_verdict = 'ambiguo' THEN
      IF NULLIF(v_row->>'comment_body', '') IS NULL THEN
        RAISE EXCEPTION 'ambiguity comment body is required';
      END IF;
      INSERT INTO public.project_comments (
        project_id, document_id, field_name, field_review_id, author_id, body
      ) VALUES (
        p_project_id, p_document_id, v_review.field_name, v_review.id,
        p_reviewer_id, v_row->>'comment_body'
      ) ON CONFLICT DO NOTHING;
    ELSIF v_verdict = 'contesta_llm' AND v_review.arbitrator_id IS NULL THEN
      v_contested_ids := pg_catalog.array_append(v_contested_ids, v_review.id);
    END IF;
  END LOOP;

  IF pg_catalog.cardinality(v_contested_ids) > 0 THEN
    SELECT member.user_id INTO v_arbitrator_id
    FROM public.project_members AS member
    WHERE member.project_id = p_project_id
      AND member.can_arbitrate = true
      AND member.user_id <> p_reviewer_id
    ORDER BY
      EXISTS (
        SELECT 1 FROM public.responses AS coder
        WHERE coder.project_id = p_project_id
          AND coder.document_id = p_document_id
          AND coder.respondent_type = 'humano'
          AND coder.respondent_id = member.user_id
      ),
      (SELECT count(*) FROM public.assignments AS open_assignment
       WHERE open_assignment.project_id = p_project_id
         AND open_assignment.user_id = member.user_id
         AND open_assignment.type = 'arbitragem'
         AND open_assignment.status <> 'concluido'),
      CASE WHEN member.role = 'pesquisador' THEN 0 ELSE 1 END,
      pg_catalog.random()
    LIMIT 1
    FOR UPDATE OF member;

    IF v_arbitrator_id IS NOT NULL THEN
      UPDATE public.field_reviews
      SET arbitrator_id = v_arbitrator_id
      WHERE id = ANY(v_contested_ids) AND arbitrator_id IS NULL;
      GET DIAGNOSTICS v_arbitrated = ROW_COUNT;

      IF v_arbitrated > 0 THEN
        INSERT INTO public.assignments (
          project_id, document_id, user_id, type, status
        ) VALUES (
          p_project_id, p_document_id, v_arbitrator_id, 'arbitragem', 'pendente'
        ) ON CONFLICT (document_id, user_id, type) DO UPDATE
          SET status = 'pendente',
              completed_at = NULL
          WHERE assignments.status = 'concluido';
      END IF;
    END IF;
  END IF;

  UPDATE public.assignments AS assignment
  SET status = 'concluido', completed_at = pg_catalog.now()
  WHERE assignment.project_id = p_project_id
    AND assignment.document_id = p_document_id
    AND assignment.user_id = p_reviewer_id
    AND assignment.type = 'auto_revisao'
    AND NOT EXISTS (
      SELECT 1 FROM public.field_reviews AS review
      WHERE review.project_id = p_project_id
        AND review.document_id = p_document_id
        AND review.self_reviewer_id = p_reviewer_id
        AND review.self_verdict IS NULL
    );

  RETURN pg_catalog.jsonb_build_object(
    'arbitrated', v_arbitrated,
    'no_pool', pg_catalog.cardinality(v_contested_ids) > 0
      AND v_arbitrator_id IS NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.submit_auto_review_verdicts(UUID, UUID, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_auto_review_verdicts(UUID, UUID, UUID, JSONB)
  TO service_role;

CREATE OR REPLACE FUNCTION public.submit_final_review_verdicts(
  p_project_id UUID,
  p_document_id UUID,
  p_arbitrator_id UUID,
  p_rows JSONB
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row JSONB;
  v_review public.field_reviews%ROWTYPE;
  v_verdict TEXT;
  v_count INTEGER := 0;
BEGIN
  IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array'
     OR pg_catalog.jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'p_rows must be a non-empty JSON array';
  END IF;

  -- O fecho le "nao resta contestacao pendente" e marca o assignment como
  -- concluido; qualquer criador de contestacao que intercale entre a leitura e
  -- a escrita reproduz o estado da #582 por corrida (contestacao gravada,
  -- assignment 'concluido'). Sao DOIS criadores, e eles usam chaves de lock
  -- diferentes -- logo o fecho precisa adquirir as DUAS:
  --   1. submit_auto_review_verdicts: hashtextextended('project:document');
  --   2. assign_arbitration_cycles_if_eligible (caminho do retry, via
  --      lock_arbitration_assignment da 20260724100100):
  --      hashtextextended('arbitration-assignment:project:document:user').
  -- A ordem de aquisicao aqui (1 depois 2) e a unica no schema em que ambas
  -- sao tomadas na mesma transacao -- os dois criadores tomam so a sua --,
  -- entao nao ha ciclo de espera possivel entre elas.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_project_id::TEXT || ':' || p_document_id::TEXT,
      0
    )
  );
  PERFORM public.lock_arbitration_assignment(
    p_project_id,
    p_document_id,
    p_arbitrator_id
  );

  FOR v_row IN SELECT row FROM pg_catalog.jsonb_array_elements(p_rows) AS rows(row)
  LOOP
    SELECT * INTO v_review
    FROM public.field_reviews AS review
    WHERE review.id = (v_row->>'field_review_id')::UUID
      AND review.project_id = p_project_id
      AND review.document_id = p_document_id
      AND review.field_name = v_row->>'field_name'
      AND review.arbitrator_id = p_arbitrator_id
      AND review.superseded_at IS NULL
    FOR UPDATE;

    v_verdict := v_row->>'verdict';
    IF v_review.id IS NULL OR v_review.blind_verdict IS NULL
       OR v_verdict NOT IN ('humano', 'llm')
       OR (v_review.final_verdict IS NOT NULL AND v_review.final_verdict <> v_verdict)
       OR (v_verdict = 'llm' AND NULLIF(
         pg_catalog.btrim(v_row->>'question_improvement_suggestion'), ''
       ) IS NULL) THEN
      RAISE EXCEPTION 'invalid or conflicting final review verdict';
    END IF;

    IF v_review.final_verdict IS NULL THEN
      UPDATE public.field_reviews
      SET final_verdict = v_verdict,
          final_decided_at = pg_catalog.now(),
          question_improvement_suggestion =
            NULLIF(v_row->>'question_improvement_suggestion', ''),
          arbitrator_comment = NULLIF(v_row->>'arbitrator_comment', '')
      WHERE id = v_review.id;
      v_count := v_count + 1;
    END IF;

    IF v_verdict = 'llm' THEN
      IF NULLIF(v_row->>'comment_body', '') IS NULL THEN
        RAISE EXCEPTION 'final divergence comment body is required';
      END IF;
      INSERT INTO public.project_comments (
        project_id, document_id, field_name, field_review_id, author_id, body
      ) VALUES (
        p_project_id, p_document_id, v_review.field_name, v_review.id,
        p_arbitrator_id, v_row->>'comment_body'
      ) ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;

  UPDATE public.assignments AS assignment
  SET status = 'concluido', completed_at = pg_catalog.now()
  WHERE assignment.project_id = p_project_id
    AND assignment.document_id = p_document_id
    AND assignment.user_id = p_arbitrator_id
    AND assignment.type = 'arbitragem'
    AND NOT EXISTS (
      SELECT 1 FROM public.field_reviews AS review
      WHERE review.project_id = p_project_id
        AND review.document_id = p_document_id
        AND review.arbitrator_id = p_arbitrator_id
        AND review.final_verdict IS NULL
    );

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_final_review_verdicts(UUID, UUID, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_final_review_verdicts(UUID, UUID, UUID, JSONB)
  TO service_role;

-- Reparo medido (2026-07-23, produção): 0 assignments 'arbitragem' concluídos
-- com field_review contestado pendente do mesmo árbitro (82 assignments de
-- arbitragem no total). O UPDATE abaixo é idempotente e existe para instâncias
-- que tenham acumulado o estado órfão antes desta migration.
UPDATE public.assignments AS assignment
SET status = 'pendente', completed_at = NULL
WHERE assignment.type = 'arbitragem'
  AND assignment.status = 'concluido'
  AND EXISTS (
    SELECT 1 FROM public.field_reviews AS review
    WHERE review.project_id = assignment.project_id
      AND review.document_id = assignment.document_id
      AND review.arbitrator_id = assignment.user_id
      AND review.self_verdict = 'contesta_llm'
      AND review.final_verdict IS NULL
      AND review.superseded_at IS NULL
  );
