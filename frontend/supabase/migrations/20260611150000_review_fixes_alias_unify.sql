-- Correções da revisão do PR #180 (spec 002).
--
-- 1) A policy "Researchers update own assignments" (20260401100000) ficou de
--    fora da extensão de alias em 20260611130000: continuava exigindo
--    user_id = clerk_uid(), então uma conta vinculada que submetia uma
--    codificação tinha o UPDATE de status do assignment silenciosamente
--    bloqueado (0 linhas) — o assignment ficava preso em "em_andamento".
--
-- 2) unify_project_members v2: migra também verdict_acknowledgments
--    (respondent_id, com colisão UNIQUE(review_id, respondent_id) tratada —
--    target prevalece, como nas demais) e limpa a linha órfã do source em
--    researcher_field_orders (preferência pessoal, não herdada).

-- ========== 1. assignments — own rows aceitam o id canônico via alias ==========
DROP POLICY IF EXISTS "Researchers update own assignments" ON assignments;
CREATE POLICY "Researchers update own assignments" ON assignments FOR UPDATE
  USING (user_id IN (SELECT auth_user_member_identity_ids(project_id)))
  WITH CHECK (user_id IN (SELECT auth_user_member_identity_ids(project_id)));

-- ========== 2. unify_project_members v2 ==========
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
  -- O DELETE em cascata leva junto os verdict_acknowledgments das reviews
  -- duplicadas do source (FK review_id ON DELETE CASCADE).
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

  -- ===== verdict_acknowledgments (colisão UNIQUE(review_id, respondent_id):
  -- target prevalece) — escopado às reviews do projeto =====
  DELETE FROM public.verdict_acknowledgments s
  WHERE s.respondent_id = p_source_user_id
    AND s.review_id IN (
      SELECT id FROM public.reviews WHERE project_id = p_project_id
    )
    AND EXISTS (
      SELECT 1 FROM public.verdict_acknowledgments t
      WHERE t.review_id = s.review_id
        AND t.respondent_id = p_target_user_id
    );
  UPDATE public.verdict_acknowledgments
  SET respondent_id = p_target_user_id
  WHERE respondent_id = p_source_user_id
    AND review_id IN (
      SELECT id FROM public.reviews WHERE project_id = p_project_id
    );

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

  -- ===== researcher_field_orders =====
  -- Preferência pessoal de ordenação: a do target prevalece; a linha do
  -- source viraria órfã (PK project_id+user_id, profile não é deletado).
  DELETE FROM public.researcher_field_orders
  WHERE project_id = p_project_id AND user_id = p_source_user_id;

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
