-- Alterações de elegibilidade e suas limpezas formam uma única transação.
-- As funções recebem somente a PK global do membro e derivam project_id/user_id
-- da linha que a RLS permite atualizar, eliminando pares de IDs independentes.
-- SECURITY INVOKER mantém as policies de coordenador/criador/master como fonte
-- de autorização; uma linha não autorizada produz zero linhas de retorno.

CREATE OR REPLACE FUNCTION public.set_member_arbitration_permission(
  p_member_id uuid,
  p_enabled boolean
) RETURNS TABLE(project_id uuid, released integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_project_id uuid;
  v_user_id uuid;
  v_released integer := 0;
  v_document_ids uuid[];
BEGIN
  UPDATE public.project_members AS pm
  SET can_arbitrate = p_enabled
  WHERE pm.id = p_member_id
  RETURNING pm.project_id, pm.user_id
  INTO v_project_id, v_user_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF NOT p_enabled THEN
    -- O DELETE usa exatamente os documentos liberados pelo UPDATE. Se qualquer
    -- passo falhar, inclusive o DELETE, a flag e os vereditos cegos voltam ao
    -- estado anterior junto com o restante da chamada.
    WITH released_reviews AS (
      UPDATE public.field_reviews AS fr
      SET arbitrator_id = NULL,
          blind_verdict = NULL,
          blind_decided_at = NULL
      WHERE fr.project_id = v_project_id
        AND fr.arbitrator_id = v_user_id
        AND fr.self_verdict = 'contesta_llm'
        AND fr.final_verdict IS NULL
      RETURNING fr.document_id
    )
    SELECT count(*)::integer, array_agg(DISTINCT rr.document_id)
    INTO v_released, v_document_ids
    FROM released_reviews AS rr;

    IF v_document_ids IS NOT NULL THEN
      DELETE FROM public.assignments AS a
      WHERE a.project_id = v_project_id
        AND a.user_id = v_user_id
        AND a.document_id = ANY(v_document_ids)
        AND a.type = 'arbitragem'
        AND a.status <> 'concluido';
    END IF;
  END IF;

  RETURN QUERY SELECT v_project_id, v_released;
END;
$$;

REVOKE ALL ON FUNCTION
  public.set_member_arbitration_permission(uuid, boolean)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION
  public.set_member_arbitration_permission(uuid, boolean)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.set_member_comparison_permission(
  p_member_id uuid,
  p_enabled boolean
) RETURNS TABLE(project_id uuid, released integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_project_id uuid;
  v_user_id uuid;
  v_released integer := 0;
BEGIN
  UPDATE public.project_members AS pm
  SET can_compare = p_enabled
  WHERE pm.id = p_member_id
  RETURNING pm.project_id, pm.user_id
  INTO v_project_id, v_user_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF NOT p_enabled THEN
    DELETE FROM public.assignments AS a
    WHERE a.project_id = v_project_id
      AND a.user_id = v_user_id
      AND a.type = 'comparacao'
      AND a.status = 'pendente';
    GET DIAGNOSTICS v_released = ROW_COUNT;
  END IF;

  RETURN QUERY SELECT v_project_id, v_released;
END;
$$;

REVOKE ALL ON FUNCTION
  public.set_member_comparison_permission(uuid, boolean)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION
  public.set_member_comparison_permission(uuid, boolean)
  TO authenticated;
