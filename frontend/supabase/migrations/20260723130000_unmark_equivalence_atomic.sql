-- Desfazer uma equivalência precisa remover, na mesma transação, o par e o
-- veredito que dependia dele: enquanto o DELETE de `reviews` vivia no client
-- (um statement depois da RPC), uma falha ali deixava a equivalência removida e
-- o review apontando um gabarito de grupo que não existe mais.
--
-- A assinatura de `remove_response_equivalence` é preservada de propósito.
-- `CREATE OR REPLACE` com outra lista de parâmetros cria uma SOBRECARGA em vez
-- de substituir: um `p_reviewer_id` novo produziria duas funções coexistindo,
-- com o GRANT amarrado só à de dois argumentos. Mantendo a assinatura, esta
-- migration pode ser aplicada no remoto ANTES do merge do código — o DELETE de
-- `reviews` que a versão em produção ainda executa vira um no-op idempotente
-- durante a janela.
--
-- O corpo abaixo reproduz o da 20260717120000 (advisory lock por documento,
-- predicado de autoridade com FOR UPDATE, carimbo de superseded antes do
-- DELETE para o trigger de arquivamento ler a linha já marcada) e acrescenta
-- apenas o DELETE de `reviews`.

CREATE OR REPLACE FUNCTION public.remove_response_equivalence(
  p_project_id UUID,
  p_equivalence_id UUID
) RETURNS TABLE(document_id UUID, field_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_document_id UUID;
  v_field_name TEXT;
BEGIN
  SELECT equivalence.document_id
  INTO v_document_id
  FROM public.response_equivalences AS equivalence
  WHERE equivalence.id = p_equivalence_id
    AND equivalence.project_id = p_project_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_project_id::TEXT || ':' || v_document_id::TEXT,
      0
    )
  );

  SELECT equivalence.document_id, equivalence.field_name
  INTO v_document_id, v_field_name
  FROM public.response_equivalences AS equivalence
  WHERE equivalence.id = p_equivalence_id
    AND equivalence.project_id = p_project_id
    AND (
      -- Ownership pela identidade de TRABALHO, não pelo UUID da sessão. Com
      -- `reviewer_id = clerk_uid()` uma conta-alias não conseguia desfazer o
      -- próprio par: o par pertence ao membro canônico e `clerk_uid()` é a
      -- conta vinculada, então os dois nunca batiam. A RLS da tabela já era
      -- alias-aware desde o #440, mas SECURITY DEFINER não a consulta — este
      -- predicado é a autoridade, e precisa usar a mesma fonte que ela.
      equivalence.reviewer_id IN (
        SELECT public.auth_user_member_identity_ids(p_project_id)
      )
      -- Coordenadora e criadora, também alias-aware: a função cobre os dois
      -- papéis, o que dispensa o braço separado por `created_by`.
      OR equivalence.project_id IN (
        SELECT public.auth_user_coordinator_or_creator_project_ids()
      )
      OR public.is_master()
    )
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE public.response_equivalences AS equivalence
  SET superseded_at = pg_catalog.now(),
      superseded_reason = 'manually_removed'
  WHERE equivalence.id = p_equivalence_id;

  DELETE FROM public.response_equivalences AS equivalence
  WHERE equivalence.id = p_equivalence_id;

  -- O veredito removido é o de quem chamou, não o do dono do par: um
  -- coordenador que desfaz equivalência alheia não apaga o trabalho de
  -- terceiro. Como esta função é SECURITY DEFINER, a RLS de `reviews` está
  -- desligada aqui — este IN não é filtro de conveniência, É a autorização do
  -- DELETE, e `auth_user_member_identity_ids` é a mesma fonte de identidade de
  -- trabalho que as policies usam (conta própria e contas-alias do projeto).
  DELETE FROM public.reviews AS review
  WHERE review.project_id = p_project_id
    AND review.document_id = v_document_id
    AND review.field_name = v_field_name
    AND review.reviewer_id IN (
      SELECT public.auth_user_member_identity_ids(p_project_id)
    );

  RETURN QUERY SELECT v_document_id, v_field_name;
END;
$$;

REVOKE ALL ON FUNCTION public.remove_response_equivalence(UUID, UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_response_equivalence(UUID, UUID)
  TO authenticated, service_role;
