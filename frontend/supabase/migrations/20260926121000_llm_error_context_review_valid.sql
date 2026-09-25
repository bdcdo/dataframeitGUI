-- Decisao do LLM Insights ancorada em veredito que perdeu a validade (#758).
--
-- `llm_error_context` lia a review de origem so por id: deixava abrir, e
-- redecidir, uma decisao sobre veredito dado para outra versao da pergunta,
-- e `read_error_resolutions` mantinha essa decisao valendo no Gabarito, no
-- export e na fila. A validade do veredito e a de 20260926120000
-- (`review_is_valid`).
--
-- A regra nao e "toda decisao exige fonte valida". Ela depende do que a
-- decisao grava:
--   * "Erro humano", "Erro do LLM" e "Todos errados" gravam valor proprio (a
--     resposta do LLM ou `approved_value`). Sao um julgamento novo, feito sobre
--     as respostas `is_latest` e a `field_definition` atuais, que o contexto ja
--     confere. Valem mesmo que o veredito que motivou o card esteja invalido.
--   * "Ambos corretos" e "Em discussao" nao gravam valor: o gabarito continua
--     sendo o veredito da fonte. Caem quando a fonte e invalida.
--
-- Por isso `llm_error_context` ganha `p_require_valid_source`, com default
-- `true`. Quem ABRE decisao nova chama sem o parametro: `prepareErrorResolution`
-- (RPC do cliente) e `set_error_resolution`, que recalcula o contexto e o
-- compara com o esperado. As duas passam a recusar review invalida, entao
-- nenhuma decisao nova, de qualquer tipo, nasce sobre veredito invalido.
-- `read_error_resolutions` AVALIA decisao ja gravada e so exige a fonte das
-- decisoes que nao gravam valor; a decisao com valor ja gravada nao fica
-- stale por isso. `set_error_resolution` nao muda: a chamada de 7 argumentos
-- resolve para a funcao nova pelo default.
--
-- A copia TypeScript da regra de aplicacao e `decisionDependsOnSource` em
-- `frontend/src/lib/error-resolution.ts`, usada pela fila, pelo Gabarito e
-- pelo export.
--
-- Parametro novo e funcao nova: a antiga e derrubada antes (senao o PostgREST
-- veria duas sobrecargas e a chamada de 7 argumentos seria ambigua) e os grants
-- sao reemitidos. O corpo e o de 20260918130000 com a guarda depois do SELECT
-- da review. `read_error_resolutions` mantem assinatura e grants.

BEGIN;

DROP FUNCTION public.llm_error_context(UUID, UUID, TEXT, UUID, UUID, TEXT, UUID);

CREATE FUNCTION public.llm_error_context(
  p_project_id UUID, p_document_id UUID, p_field_name TEXT,
  p_llm_response_id UUID, p_human_response_id UUID, p_source_kind TEXT, p_source_id UUID,
  p_require_valid_source BOOLEAN DEFAULT true
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
    -- Veredito dado sobre outra versao da pergunta, ou fora do dominio atual.
    IF p_require_valid_source AND NOT public.review_is_valid(v_review.id) THEN RETURN NULL; END IF;
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

REVOKE ALL ON FUNCTION public.llm_error_context(UUID, UUID, TEXT, UUID, UUID, TEXT, UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.llm_error_context(UUID, UUID, TEXT, UUID, UUID, TEXT, UUID, BOOLEAN) TO authenticated, service_role;

-- Avaliacao de decisao gravada: so as que nao gravam valor dependem da fonte.
-- A lista e a das decisoes com valor, e nao a das sem valor, para que um tipo
-- de decisao futuro nasca exigindo a fonte (fail-closed).
CREATE OR REPLACE FUNCTION public.read_error_resolutions(p_project_id UUID)
RETURNS TABLE(id UUID, project_id UUID, document_id UUID, field_name TEXT, decision TEXT,
  context JSONB, current_context JSONB, resolved_at TIMESTAMPTZ, resolved_by UUID, note TEXT, approved_value JSONB)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT r.id, r.project_id, r.document_id, r.field_name, r.decision, r.context,
    CASE WHEN r.context IS NOT NULL THEN public.llm_error_context(
      r.project_id, r.document_id, r.field_name,
      (r.context->>'llm_response_id')::UUID, (r.context->>'human_response_id')::UUID,
      r.context->'source'->>'kind', (r.context->'source'->>'id')::UUID,
      r.decision IS DISTINCT FROM 'llm_correct'
        AND r.decision IS DISTINCT FROM 'researchers_correct'
        AND r.decision IS DISTINCT FROM 'all_wrong') END,
    r.resolved_at, r.resolved_by, r.note, r.approved_value
  FROM public.error_resolutions r WHERE r.project_id = p_project_id
$$;

COMMIT;
