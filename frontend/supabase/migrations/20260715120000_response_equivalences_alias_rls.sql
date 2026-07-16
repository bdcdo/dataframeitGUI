-- Alinha response_equivalences à identidade efetiva da spec 002. Contas
-- vinculadas trabalham como o membro canônico, portanto precisam criar,
-- atualizar e excluir as linhas cujo reviewer_id é essa identidade.

-- Fonte única dos projetos em que a conta pode agir como coordenador/criador.
-- Cada braço parte de clerk_uid() ou de member_email_links.linked_user_id:
-- preserva os caminhos indexáveis da função original e acrescenta aliases sem
-- executar um helper correlacionado para cada linha de project_members.
CREATE OR REPLACE FUNCTION public.auth_user_coordinator_or_creator_project_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT pm.project_id
  FROM public.project_members AS pm
  WHERE pm.user_id = public.clerk_uid()
    AND pm.role = 'coordenador'
  UNION
  SELECT p.id
  FROM public.projects AS p
  WHERE p.created_by = public.clerk_uid()
  UNION
  SELECT pm.project_id
  FROM public.member_email_links AS mel
  JOIN public.project_members AS pm
    ON pm.project_id = mel.project_id
   AND pm.user_id = mel.member_user_id
  WHERE mel.linked_user_id = public.clerk_uid()
    AND pm.role = 'coordenador'
  UNION
  SELECT p.id
  FROM public.member_email_links AS mel
  JOIN public.projects AS p
    ON p.id = mel.project_id
   AND p.created_by = mel.member_user_id
  WHERE mel.linked_user_id = public.clerk_uid()
$$;

GRANT EXECUTE ON FUNCTION public.auth_user_coordinator_or_creator_project_ids()
  TO anon, authenticated, service_role;

-- A leitura é compartilhada no projeto e precisa incluir contas-alias; a
-- função accessible já reúne membro, criador e vínculo por e-mail.
DROP POLICY IF EXISTS "Members view response_equivalences"
  ON public.response_equivalences;
CREATE POLICY "Members view response_equivalences"
  ON public.response_equivalences
  FOR SELECT
  USING (
    project_id IN (SELECT public.auth_user_accessible_project_ids())
    OR public.is_master()
  );

DROP POLICY IF EXISTS "Reviewers manage response_equivalences"
  ON public.response_equivalences;
CREATE POLICY "Reviewers manage response_equivalences"
  ON public.response_equivalences
  FOR ALL
  USING (
    (
      project_id IN (
        SELECT public.auth_user_accessible_project_ids()
      )
      AND reviewer_id IN (
        SELECT public.auth_user_member_identity_ids(project_id)
      )
    )
    OR project_id IN (
      SELECT public.auth_user_coordinator_or_creator_project_ids()
    )
    OR public.is_master()
  )
  WITH CHECK (
    (
      project_id IN (
        SELECT public.auth_user_accessible_project_ids()
      )
      AND reviewer_id IN (
        SELECT public.auth_user_member_identity_ids(project_id)
      )
    )
    OR project_id IN (
      SELECT public.auth_user_coordinator_or_creator_project_ids()
    )
    OR public.is_master()
  );

-- Remove o par e o review da identidade efetiva na mesma transação. A função
-- permanece SECURITY INVOKER para que as policies das duas tabelas sejam a
-- autoridade; se qualquer DELETE falhar, o statement inteiro faz rollback.
CREATE OR REPLACE FUNCTION public.unmark_response_equivalence(
  p_project_id uuid,
  p_equivalence_id uuid,
  p_reviewer_id uuid
) RETURNS TABLE(document_id uuid, field_name text)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH deleted_pair AS (
    DELETE FROM public.response_equivalences AS equivalence
    WHERE equivalence.project_id = p_project_id
      AND equivalence.id = p_equivalence_id
    RETURNING equivalence.document_id, equivalence.field_name
  ),
  deleted_review AS (
    DELETE FROM public.reviews AS review
    USING deleted_pair AS pair
    WHERE review.project_id = p_project_id
      AND review.document_id = pair.document_id
      AND review.field_name = pair.field_name
      AND review.reviewer_id = p_reviewer_id
  )
  SELECT pair.document_id, pair.field_name
  FROM deleted_pair AS pair
$$;

GRANT EXECUTE ON FUNCTION public.unmark_response_equivalence(uuid, uuid, uuid)
  TO authenticated;
