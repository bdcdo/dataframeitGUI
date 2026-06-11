-- Unificação de membros num projeto (spec 002, US2 — research D4).
--
-- Migra atomicamente toda a identidade de trabalho do source para o target no
-- escopo do projeto e remove o source de project_members (papel/permissões do
-- target prevalecem). Permanente por design (clarificação Q1 da spec).
--
-- Colisões tratadas:
--   - assignments  UNIQUE(document_id, user_id, type): a linha do target
--     prevalece; a duplicada do source é removida.
--   - reviews      UNIQUE(project_id, document_id, field_name, reviewer_id):
--     idem — colisão não mapeada no data-model, detectada na implementação.
--   - responses    is_latest por (documento, respondente humano): após a
--     fusão, só a mais recente do conjunto fundido permanece is_latest = true.
--   - field_reviews: sem colisão possível — field_reviews_unique é
--     (document_id, field_name) e não envolve usuário.
--
-- p_acting_user_id: coordenador que confirmou a unificação — vira created_by
-- do alias registrado em member_email_links.

CREATE OR REPLACE FUNCTION unify_project_members(
  p_project_id UUID,
  p_source_user_id UUID,
  p_target_user_id UUID,
  p_acting_user_id UUID
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_source_email TEXT;
BEGIN
  IF p_source_user_id = p_target_user_id THEN
    RAISE EXCEPTION 'source e target devem ser membros distintos';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.project_members
    WHERE project_id = p_project_id AND user_id = p_source_user_id
  ) OR NOT EXISTS (
    SELECT 1 FROM public.project_members
    WHERE project_id = p_project_id AND user_id = p_target_user_id
  ) THEN
    RAISE EXCEPTION 'source e target devem ser membros do projeto';
  END IF;

  -- ===== assignments (colisão: target prevalece) =====
  DELETE FROM public.assignments s
  WHERE s.project_id = p_project_id
    AND s.user_id = p_source_user_id
    AND EXISTS (
      SELECT 1 FROM public.assignments t
      WHERE t.project_id = p_project_id
        AND t.user_id = p_target_user_id
        AND t.document_id = s.document_id
        AND t.type = s.type
    );
  UPDATE public.assignments
  SET user_id = p_target_user_id
  WHERE project_id = p_project_id AND user_id = p_source_user_id;

  -- ===== responses =====
  UPDATE public.responses
  SET respondent_id = p_target_user_id
  WHERE project_id = p_project_id AND respondent_id = p_source_user_id;

  -- Recalcular is_latest: entre as respostas humanas is_latest do conjunto
  -- fundido, a mais recente por documento permanece true; as demais viram
  -- false (ficam como histórico — nada é deletado, reviews/equivalences podem
  -- referenciá-las).
  WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY document_id
             ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
           ) AS rn
    FROM public.responses
    WHERE project_id = p_project_id
      AND respondent_id = p_target_user_id
      AND respondent_type = 'humano'
      AND is_latest
  )
  UPDATE public.responses r
  SET is_latest = false
  FROM ranked
  WHERE r.id = ranked.id AND ranked.rn > 1;

  -- ===== reviews (colisão: target prevalece) =====
  DELETE FROM public.reviews s
  WHERE s.project_id = p_project_id
    AND s.reviewer_id = p_source_user_id
    AND EXISTS (
      SELECT 1 FROM public.reviews t
      WHERE t.project_id = p_project_id
        AND t.reviewer_id = p_target_user_id
        AND t.document_id = s.document_id
        AND t.field_name = s.field_name
    );
  UPDATE public.reviews
  SET reviewer_id = p_target_user_id
  WHERE project_id = p_project_id AND reviewer_id = p_source_user_id;
  UPDATE public.reviews
  SET resolved_by = p_target_user_id
  WHERE project_id = p_project_id AND resolved_by = p_source_user_id;

  -- ===== field_reviews =====
  UPDATE public.field_reviews
  SET self_reviewer_id = p_target_user_id
  WHERE project_id = p_project_id AND self_reviewer_id = p_source_user_id;
  UPDATE public.field_reviews
  SET arbitrator_id = p_target_user_id
  WHERE project_id = p_project_id AND arbitrator_id = p_source_user_id;

  -- ===== project_comments =====
  UPDATE public.project_comments
  SET author_id = p_target_user_id
  WHERE project_id = p_project_id AND author_id = p_source_user_id;
  UPDATE public.project_comments
  SET resolved_by = p_target_user_id
  WHERE project_id = p_project_id AND resolved_by = p_source_user_id;

  -- ===== resoluções =====
  UPDATE public.difficulty_resolutions
  SET resolved_by = p_target_user_id
  WHERE project_id = p_project_id AND resolved_by = p_source_user_id;
  UPDATE public.error_resolutions
  SET resolved_by = p_target_user_id
  WHERE project_id = p_project_id AND resolved_by = p_source_user_id;
  UPDATE public.note_resolutions
  SET resolved_by = p_target_user_id
  WHERE project_id = p_project_id AND resolved_by = p_source_user_id;

  -- ===== response_equivalences =====
  UPDATE public.response_equivalences
  SET reviewer_id = p_target_user_id
  WHERE project_id = p_project_id AND reviewer_id = p_source_user_id;

  -- ===== llm_runs / assignment_batches =====
  UPDATE public.llm_runs
  SET started_by = p_target_user_id
  WHERE project_id = p_project_id AND started_by = p_source_user_id;
  UPDATE public.assignment_batches
  SET created_by = p_target_user_id
  WHERE project_id = p_project_id AND created_by = p_source_user_id;

  -- ===== member_email_links =====
  -- Vínculos que apontavam para o source passam a apontar para o target
  -- (e-mails não mudam, então UNIQUE(project_id, email) não colide).
  UPDATE public.member_email_links
  SET member_user_id = p_target_user_id
  WHERE project_id = p_project_id AND member_user_id = p_source_user_id;

  -- Self-alias não faz sentido (conta já é a identidade canônica).
  DELETE FROM public.member_email_links
  WHERE project_id = p_project_id AND member_user_id = linked_user_id;

  -- Registra o alias permanente: a conta source age como target neste projeto.
  SELECT email INTO v_source_email FROM public.profiles WHERE id = p_source_user_id;
  IF v_source_email IS NOT NULL THEN
    INSERT INTO public.member_email_links
      (project_id, member_user_id, email, linked_user_id, created_by)
    VALUES
      (p_project_id, p_target_user_id, lower(v_source_email), p_source_user_id, p_acting_user_id)
    ON CONFLICT (project_id, email) DO NOTHING;
  END IF;

  -- ===== project_members =====
  DELETE FROM public.project_members
  WHERE project_id = p_project_id AND user_id = p_source_user_id;
END;
$$;

-- Função privilegiada: só o admin client (service_role) chama, a partir de
-- server action com checagem prévia de coordenador.
REVOKE ALL ON FUNCTION unify_project_members(UUID, UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION unify_project_members(UUID, UUID, UUID, UUID) TO service_role;
