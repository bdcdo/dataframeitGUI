-- Restaura as guardas de elegibilidade/autoria e a reabertura na RPC de
-- arbitragem por ciclos (issue #557).
--
-- Contexto: a reescrita da arbitragem para o modelo por ciclos em
-- 20260717120000_auto_review_reconciliation_outbox.sql moveu o trabalho para
-- `assign_arbitration_cycles_if_eligible` — que é o caminho de PRODUÇÃO: o app
-- chama essa função diretamente (src/actions/field-reviews.ts). Nessa migração,
-- porém, três garantias que a versão anterior tinha
-- (20260716160100_prevent_self_arbitration.sql, assign_arbitration_if_eligible)
-- foram perdidas:
--   1. reabertura: o upsert virou `ON CONFLICT DO NOTHING` (a arbitragem
--      concluída não reabre quando surge nova divergência — o árbitro fica com
--      a revisão atribuída sem assignment ativa);
--   2. anti-autoarbitragem: caiu o filtro `self_reviewer_id <> p_user_id`;
--   3. revalidação de estado: caiu `final_verdict IS NULL` (uma revisão já
--      finalizada podia ser reatribuída) e a serialização
--      `lock_arbitration_assignment`.
--
-- Sintomas: test:db:member-permissions (reabertura) e test:db:identity (contrato
-- textual das guardas). A CHECK field_reviews_pending_distinct_actors_check
-- ainda barra fisicamente a autoarbitragem numa linha pendente, mas estourando
-- check_violation — a guarda no RPC é o caminho gracioso (retorna 0).
--
-- Correção: reissue de `assign_arbitration_cycles_if_eligible` com o conjunto
-- completo restaurado. O wrapper de compat `assign_arbitration_if_eligible`
-- delega a esta função, então continua correto por composição — não precisa
-- duplicar as guardas (o contrato textual em canonical_project_identity_rls
-- passa a inspecionar esta função, o caminho real).

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

  -- Serializa tentativas concorrentes sobre a mesma fila de arbitragem (mesmo
  -- advisory lock da versão pré-ciclos).
  PERFORM public.lock_arbitration_assignment(
    p_project_id,
    p_document_id,
    p_user_id
  );

  WITH assigned_reviews AS (
    UPDATE public.field_reviews AS review
    SET arbitrator_id = p_user_id
    WHERE review.project_id = p_project_id
      AND review.document_id = p_document_id
      AND review.id = ANY(p_field_review_ids)
      AND review.superseded_at IS NULL
      AND review.self_verdict = 'contesta_llm'
      AND review.arbitrator_id IS NULL
      -- Não rearbitra revisão já finalizada.
      AND review.final_verdict IS NULL
      -- Ninguém arbitra a própria contestação.
      AND review.self_reviewer_id <> p_user_id
    RETURNING review.id
  )
  SELECT count(*)::INTEGER INTO v_assigned FROM assigned_reviews;

  IF v_assigned > 0 THEN
    INSERT INTO public.assignments (
      project_id, document_id, user_id, type, status
    ) VALUES (
      p_project_id, p_document_id, p_user_id, 'arbitragem', 'pendente'
    )
    -- Reabre a arbitragem concluída em vez de descartar o conflito; o predicado
    -- limita a reabertura à linha 'concluido' (uma pendente segue intacta).
    ON CONFLICT (document_id, user_id, type) DO UPDATE
    SET status = 'pendente', completed_at = NULL
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
