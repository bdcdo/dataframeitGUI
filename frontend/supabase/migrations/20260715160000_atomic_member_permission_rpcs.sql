-- Alterações de elegibilidade e suas limpezas formam uma única transação.
-- As funções recebem somente a PK global do membro e derivam project_id/user_id
-- da linha que a RLS permite atualizar, eliminando pares de IDs independentes.
-- SECURITY INVOKER mantém as policies de coordenador/criador/master como fonte
-- de autorização; uma linha não autorizada produz zero linhas de retorno.

CREATE OR REPLACE FUNCTION public.set_member_arbitration_permission(
  p_member_id uuid,
  p_enabled boolean
) RETURNS TABLE(project_id uuid)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_project_id uuid;
  v_user_id uuid;
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
    SELECT array_agg(DISTINCT rr.document_id)
    INTO v_document_ids
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

  RETURN QUERY SELECT v_project_id;
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
) RETURNS TABLE(project_id uuid)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_project_id uuid;
  v_user_id uuid;
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
  END IF;

  RETURN QUERY SELECT v_project_id;
END;
$$;

REVOKE ALL ON FUNCTION
  public.set_member_comparison_permission(uuid, boolean)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION
  public.set_member_comparison_permission(uuid, boolean)
  TO authenticated;

-- A remoção e todas as revogações que fazem o acesso cessar compartilham o
-- mesmo snapshot e a mesma transação. Os CTEs de limpeza dependem da linha
-- realmente removida pela RLS; uma falha em qualquer DELETE desfaz tudo.
CREATE OR REPLACE FUNCTION public.remove_project_member(
  p_member_id uuid
) RETURNS TABLE(project_id uuid)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH removed AS MATERIALIZED (
    DELETE FROM public.project_members AS pm
    WHERE pm.id = p_member_id
    RETURNING pm.project_id, pm.user_id
  ),
  deleted_assignments AS (
    DELETE FROM public.assignments AS a
    USING removed AS r
    WHERE a.project_id = r.project_id
      AND a.user_id = r.user_id
      AND a.status = 'pendente'
    RETURNING a.id
  ),
  deleted_links AS (
    DELETE FROM public.member_email_links AS mel
    USING removed AS r
    WHERE mel.project_id = r.project_id
      AND mel.member_user_id = r.user_id
    RETURNING mel.id
  ),
  cleanup AS (
    SELECT
      (SELECT count(*) FROM deleted_assignments)
      + (SELECT count(*) FROM deleted_links) AS affected
  )
  SELECT r.project_id
  FROM removed AS r
  CROSS JOIN cleanup
$$;

REVOKE ALL ON FUNCTION public.remove_project_member(uuid)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.remove_project_member(uuid)
  TO authenticated;

-- A escolha do candidato ocorre na aplicação para preservar o balanceamento,
-- mas a validação final de elegibilidade e a gravação precisam ser uma única
-- transação. O lock na membership serializa estes commits com os UPDATEs das
-- RPCs de permissão: ou a atribuição entra antes e a limpeza a remove, ou vê a
-- flag já desabilitada e não grava nada.
CREATE OR REPLACE FUNCTION public.assign_arbitration_if_eligible(
  p_project_id uuid,
  p_document_id uuid,
  p_user_id uuid,
  p_field_names text[]
) RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_assigned integer := 0;
BEGIN
  PERFORM 1
  FROM public.project_members AS pm
  WHERE pm.project_id = p_project_id
    AND pm.user_id = p_user_id
    AND pm.can_arbitrate = true
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  WITH assigned_reviews AS (
    UPDATE public.field_reviews AS fr
    SET arbitrator_id = p_user_id
    WHERE fr.project_id = p_project_id
      AND fr.document_id = p_document_id
      AND fr.field_name = ANY(p_field_names)
      AND fr.arbitrator_id IS NULL
    RETURNING fr.id
  )
  SELECT count(*)::integer
  INTO v_assigned
  FROM assigned_reviews;

  IF v_assigned > 0 THEN
    INSERT INTO public.assignments (
      project_id,
      document_id,
      user_id,
      type,
      status
    ) VALUES (
      p_project_id,
      p_document_id,
      p_user_id,
      'arbitragem',
      'pendente'
    )
    ON CONFLICT (document_id, user_id, type) DO NOTHING;
  END IF;

  RETURN v_assigned;
END;
$$;

REVOKE ALL ON FUNCTION
  public.assign_arbitration_if_eligible(uuid, uuid, uuid, text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.assign_arbitration_if_eligible(uuid, uuid, uuid, text[])
  TO service_role;

CREATE OR REPLACE FUNCTION public.assign_comparison_if_eligible(
  p_project_id uuid,
  p_document_id uuid,
  p_user_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_inserted integer := 0;
BEGIN
  PERFORM 1
  FROM public.project_members AS pm
  WHERE pm.project_id = p_project_id
    AND pm.user_id = p_user_id
    AND pm.can_compare = true
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO public.assignments (
    project_id,
    document_id,
    user_id,
    type,
    status
  ) VALUES (
    p_project_id,
    p_document_id,
    p_user_id,
    'comparacao',
    'pendente'
  )
  ON CONFLICT (document_id, user_id, type) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  RETURN v_inserted = 1;
END;
$$;

REVOKE ALL ON FUNCTION
  public.assign_comparison_if_eligible(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.assign_comparison_if_eligible(uuid, uuid, uuid)
  TO service_role;
