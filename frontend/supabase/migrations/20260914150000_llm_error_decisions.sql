BEGIN;

ALTER TABLE public.error_resolutions
  ADD COLUMN decision TEXT CHECK (decision IN ('llm_correct', 'researchers_correct', 'discussion')),
  ADD COLUMN context JSONB,
  ADD CONSTRAINT error_resolution_context_required CHECK ((decision IS NULL) = (context IS NULL));

CREATE FUNCTION public.llm_error_context(
  p_project_id UUID, p_document_id UUID, p_field_name TEXT,
  p_llm_response_id UUID, p_human_response_id UUID, p_source_kind TEXT, p_source_id UUID
) RETURNS JSONB
-- A validade de uma decisão concluída não depende de quem participou da arbitragem.
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_project public.projects%ROWTYPE;
  v_llm public.responses%ROWTYPE;
  v_human public.responses%ROWTYPE;
  v_review public.reviews%ROWTYPE;
  v_self public.field_reviews%ROWTYPE;
  v_field JSONB;
  v_source JSONB;
  v_llm_value JSONB;
  v_human_value JSONB;
BEGIN
  IF public.clerk_uid() IS NULL OR NOT COALESCE((
    p_project_id IN (SELECT public.auth_user_project_ids())
    OR p_project_id IN (SELECT public.auth_user_coordinator_or_creator_project_ids()) OR public.is_master()
  ), false) THEN RETURN NULL; END IF;
  SELECT * INTO v_project FROM public.projects WHERE id = p_project_id;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.documents WHERE id = p_document_id AND project_id = p_project_id
      AND excluded_at IS NULL AND exclusion_pending_at IS NULL
  ) THEN RETURN NULL; END IF;
  SELECT field INTO v_field FROM pg_catalog.jsonb_array_elements(v_project.pydantic_fields) AS field
    WHERE field->>'name' = p_field_name;
  IF v_field IS NULL OR COALESCE(v_field->>'target', 'all') <> 'all' THEN RETURN NULL; END IF;

  SELECT * INTO v_llm FROM public.responses WHERE id = p_llm_response_id
    AND project_id = p_project_id AND document_id = p_document_id
    AND respondent_type = 'llm' AND is_latest
    AND round_id IS NOT DISTINCT FROM v_project.current_round_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO v_human FROM public.responses WHERE id = p_human_response_id
    AND project_id = p_project_id AND document_id = p_document_id
    AND respondent_type = 'humano' AND is_latest
    AND round_id IS NOT DISTINCT FROM v_project.current_round_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_llm_value := v_llm.answers->p_field_name;
  v_human_value := v_human.answers->p_field_name;

  IF p_source_kind = 'comparacao' THEN
    SELECT * INTO v_review FROM public.reviews WHERE id = p_source_id
      AND project_id = p_project_id AND document_id = p_document_id AND field_name = p_field_name;
    IF NOT FOUND THEN RETURN NULL; END IF;
    v_source := pg_catalog.jsonb_build_object('kind', p_source_kind, 'id', v_review.id,
      'verdict', v_review.verdict, 'chosen_response_id', v_review.chosen_response_id,
      'response_snapshot', v_review.response_snapshot, 'comment', v_review.comment);
  ELSIF p_source_kind = 'auto_revisao' AND v_project.automation_mode = 'auto_review_llm' THEN
    SELECT * INTO v_self FROM public.field_reviews WHERE id = p_source_id
      AND project_id = p_project_id AND document_id = p_document_id AND field_name = p_field_name
      AND human_response_id = v_human.id AND llm_response_id = v_llm.id AND superseded_at IS NULL;
    IF NOT FOUND OR v_self.final_verdict IS NULL OR
      public.is_auto_review_reconciliation_pending(p_project_id, p_document_id, v_llm.id)
      OR v_self.llm_answer_snapshot IS DISTINCT FROM v_llm_value
      OR v_self.human_answer_snapshot IS DISTINCT FROM v_human_value
    THEN RETURN NULL; END IF;
    v_llm_value := v_self.llm_answer_snapshot;
    v_human_value := v_self.human_answer_snapshot;
    v_source := pg_catalog.jsonb_build_object('kind', p_source_kind, 'id', v_self.id,
      'cycle_no', v_self.cycle_no, 'self_verdict', v_self.self_verdict,
      'final_verdict', v_self.final_verdict, 'final_decided_at', v_self.final_decided_at,
      'arbitrator_comment', v_self.arbitrator_comment);
  ELSE RETURN NULL;
  END IF;

  -- O hash cobre condicionantes sem repetir a resposta inteira em cada decisão de campo.
  v_source := v_source || pg_catalog.jsonb_build_object(
    'schema_revision', v_project.schema_revision,
    'responses_hash', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_object('llm', v_llm.answers, 'human', v_human.answers,
        'llm_field_hashes', v_llm.answer_field_hashes, 'human_field_hashes', v_human.answer_field_hashes,
        'llm_justifications', v_llm.justifications, 'human_justifications', v_human.justifications)::TEXT,
      'UTF8')), 'hex'),
    'reviews', (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', r.id, 'verdict', r.verdict, 'chosen_response_id', r.chosen_response_id,
      'comment', r.comment, 'response_snapshot', r.response_snapshot) ORDER BY r.id), '[]'::JSONB)
      FROM public.reviews r WHERE r.project_id = p_project_id AND r.document_id = p_document_id AND r.field_name = p_field_name),
    'auto_reviews', (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', fr.id, 'cycle_no', fr.cycle_no, 'final_verdict', fr.final_verdict,
      'final_decided_at', fr.final_decided_at) ORDER BY fr.id), '[]'::JSONB)
      FROM public.field_reviews fr WHERE fr.project_id = p_project_id AND fr.document_id = p_document_id
        AND fr.field_name = p_field_name AND fr.superseded_at IS NULL));
  RETURN pg_catalog.jsonb_build_object(
    'project_id', p_project_id, 'document_id', p_document_id, 'field_name', p_field_name,
    'round_id', v_project.current_round_id, 'automation_mode', v_project.automation_mode,
    'field_definition', v_field, 'llm_response_id', v_llm.id, 'human_response_id', v_human.id,
    'llm_value', pg_catalog.jsonb_build_object('present', v_llm.answers ? p_field_name, 'value', v_llm_value),
    'human_value', pg_catalog.jsonb_build_object('present', v_human.answers ? p_field_name, 'value', v_human_value),
    'source', v_source);
END $$;

CREATE FUNCTION public.read_error_resolutions(p_project_id UUID)
RETURNS TABLE(id UUID, project_id UUID, document_id UUID, field_name TEXT, decision TEXT,
  context JSONB, current_context JSONB, resolved_at TIMESTAMPTZ, resolved_by UUID, note TEXT)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT r.id, r.project_id, r.document_id, r.field_name, r.decision, r.context,
    CASE WHEN r.context IS NOT NULL THEN public.llm_error_context(
      r.project_id, r.document_id, r.field_name,
      (r.context->>'llm_response_id')::UUID, (r.context->>'human_response_id')::UUID,
      r.context->'source'->>'kind', (r.context->'source'->>'id')::UUID) END,
    r.resolved_at, r.resolved_by, r.note
  FROM public.error_resolutions r WHERE r.project_id = p_project_id
$$;

CREATE FUNCTION public.set_error_resolution(
  p_project_id UUID, p_document_id UUID, p_field_name TEXT,
  p_decision TEXT, p_expected_context JSONB, p_expected_id UUID,
  p_expected_resolved_at TIMESTAMPTZ, p_note TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor UUID := public.clerk_uid();
  v_existing public.error_resolutions%ROWTYPE;
  v_context JSONB;
  v_saved public.error_resolutions%ROWTYPE;
BEGIN
  IF v_actor IS NULL OR NOT COALESCE((
    p_project_id IN (SELECT public.auth_user_coordinator_or_creator_project_ids())
    OR p_project_id IN (SELECT public.auth_user_resolver_project_ids()) OR public.is_master()
  ), false) THEN RAISE EXCEPTION 'Sem permissão para decidir esta divergência' USING ERRCODE = '42501'; END IF;
  IF p_decision IS NOT NULL AND p_decision NOT IN ('llm_correct', 'researchers_correct', 'discussion')
    THEN RAISE EXCEPTION 'Decisão inválida' USING ERRCODE = '22023'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'error-resolution:' || p_project_id || ':' || p_document_id || ':' || p_field_name, 0));
  SELECT * INTO v_existing FROM public.error_resolutions
    WHERE project_id = p_project_id AND document_id = p_document_id AND field_name = p_field_name FOR UPDATE;
  IF v_existing.id IS DISTINCT FROM p_expected_id OR v_existing.resolved_at IS DISTINCT FROM p_expected_resolved_at THEN
    RAISE EXCEPTION 'A decisão mudou. Recarregue antes de confirmar.' USING ERRCODE = '40001';
  END IF;
  IF p_decision IS NULL THEN
    IF v_existing.id IS NULL THEN RAISE EXCEPTION 'Esta divergência já está aberta.' USING ERRCODE = '40001'; END IF;
    DELETE FROM public.error_resolutions WHERE id = v_existing.id;
    RETURN pg_catalog.jsonb_build_object('reopened', true);
  END IF;

  v_context := public.llm_error_context(p_project_id, p_document_id, p_field_name,
    (p_expected_context->>'llm_response_id')::UUID, (p_expected_context->>'human_response_id')::UUID,
    p_expected_context->'source'->>'kind', (p_expected_context->'source'->>'id')::UUID);
  IF v_context IS NULL OR v_context IS DISTINCT FROM p_expected_context THEN
    RAISE EXCEPTION 'As respostas mudaram. Recarregue antes de confirmar.' USING ERRCODE = '40001';
  END IF;
  IF (p_decision = 'llm_correct' AND NOT (v_context->'llm_value'->>'present')::BOOLEAN)
    OR (p_decision = 'researchers_correct' AND NOT (v_context->'human_value'->>'present')::BOOLEAN)
    THEN RAISE EXCEPTION 'A resposta escolhida não contém este campo.' USING ERRCODE = '22023'; END IF;

  INSERT INTO public.error_resolutions (project_id, document_id, field_name, decision, context, resolved_by, resolved_at, note)
  VALUES (p_project_id, p_document_id, p_field_name, p_decision, v_context, v_actor, pg_catalog.clock_timestamp(), NULLIF(pg_catalog.btrim(p_note), ''))
  ON CONFLICT (project_id, document_id, field_name) DO UPDATE
    SET decision = EXCLUDED.decision, context = EXCLUDED.context, resolved_by = EXCLUDED.resolved_by,
        resolved_at = EXCLUDED.resolved_at, note = EXCLUDED.note
  RETURNING * INTO v_saved;
  RETURN pg_catalog.to_jsonb(v_saved);
END $$;

DROP POLICY "Members view error_resolutions" ON public.error_resolutions;
CREATE POLICY "Members view error_resolutions" ON public.error_resolutions FOR SELECT USING (
  project_id IN (SELECT public.auth_user_project_ids())
  OR project_id IN (SELECT public.auth_user_coordinator_or_creator_project_ids()) OR public.is_master()
);

REVOKE ALL ON public.error_resolutions FROM anon, authenticated;
GRANT SELECT ON public.error_resolutions TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.llm_error_context(UUID, UUID, TEXT, UUID, UUID, TEXT, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.read_error_resolutions(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_error_resolution(UUID, UUID, TEXT, TEXT, JSONB, UUID, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.llm_error_context(UUID, UUID, TEXT, UUID, UUID, TEXT, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.read_error_resolutions(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_error_resolution(UUID, UUID, TEXT, TEXT, JSONB, UUID, TIMESTAMPTZ, TEXT) TO authenticated, service_role;

COMMIT;
