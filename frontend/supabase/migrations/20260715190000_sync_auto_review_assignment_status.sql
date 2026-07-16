-- A auto-revisão fechava o assignment com SELECT pendentes → UPDATE em duas
-- requests separadas, sem lock. Entre as duas, um field_review novo liberado
-- para o mesmo (documento, auto-revisor) ficava invisível ao fechamento: o
-- assignment ia para 'concluido' com self_verdict IS NULL vivo, e o documento
-- saía da fila do pesquisador sem volta. É a mesma corrida que
-- sync_arbitration_assignment_status já fecha na arbitragem; esta função
-- espelha aquele desenho para a fila irmã.
BEGIN;

-- Atribuição e fechamento da mesma fila compartilham uma única chave, então em
-- qualquer ordem concorrente ou o fechamento enxerga o campo pendente novo, ou
-- a atribuição posterior reabre o assignment depois do fechamento.
CREATE OR REPLACE FUNCTION public.lock_auto_review_assignment(
  p_project_id UUID,
  p_document_id UUID,
  p_user_id UUID
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'auto-review-assignment:'
        || p_project_id::text || ':'
        || p_document_id::text || ':'
        || p_user_id::text,
      0
    )
  )
$$;

REVOKE ALL ON FUNCTION public.lock_auto_review_assignment(UUID, UUID, UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lock_auto_review_assignment(UUID, UUID, UUID)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.sync_auto_review_assignment_status(
  p_project_id UUID,
  p_document_id UUID,
  p_user_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- SECURITY DEFINER passa por cima da RLS, então a autorização é explícita: o
  -- chamador só fecha a fila de uma identidade que já é sua no projeto.
  IF public.clerk_uid() IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.auth_user_member_identity_ids(p_project_id) AS identity(user_id)
    WHERE identity.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'usuário não pode sincronizar esta fila de auto-revisão'
      USING ERRCODE = '42501';
  END IF;

  -- A mesma ordem membership→advisory usada pela atribuição evita ciclos com
  -- remoção/unificação de membros e mantém a identidade canônica estável.
  PERFORM 1
  FROM public.project_members AS pm
  WHERE pm.project_id = p_project_id
    AND pm.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  PERFORM public.lock_auto_review_assignment(
    p_project_id,
    p_document_id,
    p_user_id
  );

  -- O envio é parcial: enquanto sobrar um campo sem veredito, o documento
  -- continua na fila.
  IF EXISTS (
    SELECT 1
    FROM public.field_reviews AS review
    WHERE review.project_id = p_project_id
      AND review.document_id = p_document_id
      AND review.self_reviewer_id = p_user_id
      AND review.self_verdict IS NULL
  ) THEN
    RETURN false;
  END IF;

  UPDATE public.assignments AS assignment
  SET status = 'concluido',
      completed_at = pg_catalog.statement_timestamp()
  WHERE assignment.project_id = p_project_id
    AND assignment.document_id = p_document_id
    AND assignment.user_id = p_user_id
    AND assignment.type = 'auto_revisao'
    AND assignment.status IS DISTINCT FROM 'concluido';

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION
  public.sync_auto_review_assignment_status(UUID, UUID, UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  public.sync_auto_review_assignment_status(UUID, UUID, UUID)
  TO authenticated, service_role;

COMMIT;
