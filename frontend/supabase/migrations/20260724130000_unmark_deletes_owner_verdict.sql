-- Dissolver um par de equivalência é evento do DOCUMENTO, não de quem clicou
-- (issue #545, decisão de produto): o gabarito que o veredito do dono do par
-- apontava representava um grupo fundido que deixa de existir, então esse
-- veredito precisa sair junto — forçando novo voto — mesmo quando quem desfaz
-- é a coordenação. Isto inverte a fronteira que a 20260723130000 travava
-- ("coordenador não apaga veredito de terceiro"); a fronteira que permanece é
-- outra: vereditos de revisores que NÃO são o dono nem o chamador nunca saem.
--
-- O DELETE por `review.reviewer_id = v_owner_id` (igualdade simples) basta:
-- reviews e pares são gravados sempre com a identidade de trabalho CANÔNICA
-- (`resolveProjectMemberActor` no client, e o próprio comentário do predicado
-- abaixo), então uma conta-alias nunca tem review sob o próprio uid — não há
-- aliases a expandir para o dono.
--
-- A assinatura e o RETURNS TABLE são preservados de propósito, pelo mesmo
-- racional da 20260723130000: `CREATE OR REPLACE` com outra lista de
-- parâmetros criaria uma sobrecarga em vez de substituir, e manter o contrato
-- permite aplicar esta migration no remoto ANTES do merge do código — o client
-- em produção só chama a RPC e sincroniza o próprio assignment, e segue
-- funcionando durante a janela (o assignment do dono fica momentaneamente
-- stale até o próximo sync, a mesma lacuna que já existia).

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
  v_owner_id UUID;
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

  SELECT equivalence.document_id, equivalence.field_name, equivalence.reviewer_id
  INTO v_document_id, v_field_name, v_owner_id
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

  -- Saem dois vereditos: o de quem chamou (identidade de trabalho, como na
  -- versão anterior) e o do DONO do par — cujo gabarito apontava o grupo que
  -- acabou de ser dissolvido (#545). Quando o dono é quem chama, os dois
  -- braços casam a mesma linha. Vereditos de outros revisores no mesmo
  -- (documento, campo) permanecem: eles não dependiam do par. Como esta função
  -- é SECURITY DEFINER, a RLS de `reviews` está desligada aqui — este
  -- predicado não é filtro de conveniência, É a autorização do DELETE, e
  -- `auth_user_member_identity_ids` é a mesma fonte de identidade de trabalho
  -- que as policies usam (conta própria e contas-alias do projeto).
  --
  -- `response_equivalences.reviewer_id` é NULLABLE (20260504000000): num par
  -- sem dono `v_owner_id` fica NULL e a igualdade não casa linha alguma — o
  -- braço some em vez de alargar o DELETE. Falha fechada de propósito: um par
  -- órfão dissolve sem arrastar veredito de ninguém.
  DELETE FROM public.reviews AS review
  WHERE review.project_id = p_project_id
    AND review.document_id = v_document_id
    AND review.field_name = v_field_name
    AND (
      review.reviewer_id IN (
        SELECT public.auth_user_member_identity_ids(p_project_id)
      )
      OR review.reviewer_id = v_owner_id
    );

  RETURN QUERY SELECT v_document_id, v_field_name;
END;
$$;

REVOKE ALL ON FUNCTION public.remove_response_equivalence(UUID, UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_response_equivalence(UUID, UUID)
  TO authenticated, service_role;
