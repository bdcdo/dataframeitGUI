-- Reabre o assignment de arbitragem quando surge nova contestacao sobre um
-- documento cuja arbitragem anterior ja foi concluida.
--
-- Regressao do #510: ate a 20260716160100_prevent_self_arbitration.sql, a
-- funcao assign_arbitration_if_eligible fazia
--   ON CONFLICT (document_id, user_id, type) DO UPDATE
--     SET status = 'pendente', completed_at = NULL
--     WHERE assignments.status = 'concluido';
-- ou seja, reabria um assignment ja concluido quando havia trabalho novo. A
-- 20260717120000_auto_review_reconciliation_outbox.sql refatorou a arbitragem
-- para assign_arbitration_cycles_if_eligible e, no processo, trocou esse
-- DO UPDATE por DO NOTHING -- perdendo a reabertura. Efeito em producao: apos
-- uma arbitragem concluida, uma nova contestacao (self_verdict volta a
-- 'contesta_llm', arbitrator_id NULL) re-atribui o arbitro no field_review
-- (v_assigned = 1), mas o assignment fica preso em 'concluido' e o arbitro
-- nunca reve a fila. Mesma classe de bug do #440 (ON CONFLICT DO NOTHING nunca
-- reabre linha concluida).
--
-- Correcao: restaurar o DO UPDATE de reabertura, identico ao padrao canonico ja
-- usado por assign_auto_reviews_if_eligible (20260716160300) e pelo fechamento
-- da auto-revisao (20260717120000). O guard WHERE assignments.status =
-- 'concluido' garante idempotencia e nao rebaixa um assignment 'em_andamento'.
--
-- So o ON CONFLICT muda; o resto do corpo e identico ao de 20260717120000.

CREATE OR REPLACE FUNCTION public.assign_arbitration_cycles_if_eligible(
  p_project_id UUID,
  p_document_id UUID,
  p_user_id UUID,
  p_field_review_ids UUID[]
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_assigned INTEGER := 0;
BEGIN
  PERFORM 1
  FROM public.project_members AS member
  WHERE member.project_id = p_project_id
    AND member.user_id = p_user_id
    AND member.can_arbitrate = true
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  WITH assigned_reviews AS (
    UPDATE public.field_reviews AS review
    SET arbitrator_id = p_user_id
    WHERE review.project_id = p_project_id
      AND review.document_id = p_document_id
      AND review.id = ANY(p_field_review_ids)
      AND review.superseded_at IS NULL
      AND review.self_verdict = 'contesta_llm'
      AND review.arbitrator_id IS NULL
    RETURNING review.id
  )
  SELECT count(*)::INTEGER INTO v_assigned FROM assigned_reviews;

  IF v_assigned > 0 THEN
    INSERT INTO public.assignments (
      project_id, document_id, user_id, type, status
    ) VALUES (
      p_project_id, p_document_id, p_user_id, 'arbitragem', 'pendente'
    )
    ON CONFLICT (document_id, user_id, type) DO UPDATE
    SET status = 'pendente',
        completed_at = NULL
    WHERE assignments.status = 'concluido';
  END IF;

  RETURN v_assigned;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_arbitration_cycles_if_eligible(
  UUID, UUID, UUID, UUID[]
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_arbitration_cycles_if_eligible(
  UUID, UUID, UUID, UUID[]
) TO service_role;
