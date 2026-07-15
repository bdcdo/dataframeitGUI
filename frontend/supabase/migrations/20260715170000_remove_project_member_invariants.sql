-- Invariantes da remoção de membros (issue #177).
--
-- Alias concede acesso futuro e assignment pendente representa trabalho ainda
-- não iniciado. Nenhum dos dois pode sobreviver sem a membership canônica. O
-- saneamento permite instalar essas invariantes sobre bancos que passaram pelo
-- fluxo best-effort anterior.
DO $$
DECLARE
  v_orphan_aliases integer;
  v_orphan_pending_assignments integer;
BEGIN
  DELETE FROM public.member_email_links AS mel
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.project_members AS pm
    WHERE pm.project_id = mel.project_id
      AND pm.user_id = mel.member_user_id
  );
  GET DIAGNOSTICS v_orphan_aliases = ROW_COUNT;

  DELETE FROM public.assignments AS a
  WHERE a.status = 'pendente'
    AND NOT EXISTS (
      SELECT 1
      FROM public.project_members AS pm
      WHERE pm.project_id = a.project_id
        AND pm.user_id = a.user_id
    );
  GET DIAGNOSTICS v_orphan_pending_assignments = ROW_COUNT;

  RAISE NOTICE
    'Saneamento: % alias(es) órfão(s) e % assignment(s) pendente(s) órfão(s) removido(s).',
    v_orphan_aliases,
    v_orphan_pending_assignments;
END;
$$;

-- Um alias sempre referencia a membership canônica do mesmo projeto. A FK
-- também serializa a criação do alias com a remoção da membership.
ALTER TABLE public.member_email_links
  ADD CONSTRAINT member_email_links_project_member_fkey
  FOREIGN KEY (project_id, member_user_id)
  REFERENCES public.project_members (project_id, user_id)
  ON DELETE CASCADE;

-- Histórico iniciado ou concluído pode sobreviver à saída do membro. Uma
-- pendência, por outro lado, só existe enquanto há membership ativa. O lock de
-- chave serializa writers de pendências com o DELETE da membership.
CREATE OR REPLACE FUNCTION public.enforce_pending_assignment_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM 1
  FROM public.project_members AS pm
  WHERE pm.project_id = NEW.project_id
    AND pm.user_id = NEW.user_id
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Assignment pendente exige membro ativo no mesmo projeto.'
      USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_pending_assignment_membership()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER enforce_pending_assignment_membership
  BEFORE INSERT OR UPDATE ON public.assignments
  FOR EACH ROW
  WHEN (NEW.status = 'pendente')
  EXECUTE FUNCTION public.enforce_pending_assignment_membership();

-- Toda remoção de membership libera suas pendências na mesma transação. A FK
-- composta acima cuida dos aliases; trabalho iniciado/concluído é preservado.
CREATE OR REPLACE FUNCTION public.release_pending_assignments_before_member_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.assignments AS a
  WHERE a.project_id = OLD.project_id
    AND a.user_id = OLD.user_id
    AND a.status = 'pendente';

  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.release_pending_assignments_before_member_delete()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER release_pending_assignments_before_member_delete
  BEFORE DELETE ON public.project_members
  FOR EACH ROW
  EXECUTE FUNCTION public.release_pending_assignments_before_member_delete();

-- Ao substituir documentos, somente assignments de memberships ainda ativas
-- podem voltar a pendente. O histórico de ex-membros permanece no estado em
-- que foi produzido.
CREATE OR REPLACE FUNCTION public.replace_and_add_documents(
  p_project_id uuid,
  p_existing_doc_ids uuid[],
  p_delete_responses boolean,
  p_duplicate_updates jsonb,
  p_new_documents jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_inserted integer := 0;
BEGIN
  IF p_delete_responses
     AND p_existing_doc_ids IS NOT NULL
     AND array_length(p_existing_doc_ids, 1) > 0 THEN
    DELETE FROM public.reviews
    WHERE project_id = p_project_id
      AND document_id = ANY(p_existing_doc_ids);

    DELETE FROM public.responses
    WHERE project_id = p_project_id
      AND document_id = ANY(p_existing_doc_ids);

    UPDATE public.assignments AS a
    SET status = 'pendente'
    WHERE a.project_id = p_project_id
      AND a.document_id = ANY(p_existing_doc_ids)
      AND EXISTS (
        SELECT 1
        FROM public.project_members AS pm
        WHERE pm.project_id = a.project_id
          AND pm.user_id = a.user_id
      );
  END IF;

  IF p_duplicate_updates IS NOT NULL
     AND jsonb_array_length(p_duplicate_updates) > 0 THEN
    UPDATE public.documents AS d
    SET text = u."text",
        title = u.title,
        external_id = u.external_id,
        text_hash = u.text_hash,
        metadata = u.metadata
    FROM jsonb_to_recordset(p_duplicate_updates)
      AS u(
        id uuid,
        "text" text,
        title text,
        external_id text,
        text_hash text,
        metadata jsonb
      )
    WHERE d.id = u.id
      AND d.project_id = p_project_id;
  END IF;

  IF p_new_documents IS NOT NULL
     AND jsonb_array_length(p_new_documents) > 0 THEN
    INSERT INTO public.documents (
      project_id,
      external_id,
      title,
      text,
      text_hash,
      metadata
    )
    SELECT
      p_project_id,
      n.external_id,
      n.title,
      n."text",
      n.text_hash,
      n.metadata
    FROM jsonb_to_recordset(p_new_documents)
      AS n(
        external_id text,
        title text,
        "text" text,
        text_hash text,
        metadata jsonb
      );
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
  END IF;

  RETURN v_inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_and_add_documents(
  uuid,
  uuid[],
  boolean,
  jsonb,
  jsonb
) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.replace_and_add_documents(
  uuid,
  uuid[],
  boolean,
  jsonb,
  jsonb
) TO authenticated;

-- A autoidentidade não pode ser removida nem por DELETE direto no PostgREST.
-- Como policy restritiva, esta condição complementa todos os caminhos
-- permissivos atuais e futuros de administração de membros.
DROP POLICY IF EXISTS "Members cannot remove their own identity"
  ON public.project_members;
CREATE POLICY "Members cannot remove their own identity"
  ON public.project_members
  AS RESTRICTIVE
  FOR DELETE
  TO authenticated
  USING (
    NOT (
      user_id IN (
        SELECT public.auth_user_member_identity_ids(project_id)
      )
    )
  );

-- A PK global é a única entrada da RPC. project_id e user_id vêm da linha que
-- a RLS permite enxergar e remover. O lock também impede que um alias novo seja
-- ligado ao alvo entre a checagem de autoidentidade e o DELETE.
CREATE OR REPLACE FUNCTION public.remove_project_member(
  p_member_id uuid
) RETURNS TABLE(project_id uuid)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_project_id uuid;
  v_user_id uuid;
BEGIN
  SELECT pm.project_id, pm.user_id
  INTO v_project_id, v_user_id
  FROM public.project_members AS pm
  WHERE pm.id = p_member_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF v_user_id IN (
    SELECT public.auth_user_member_identity_ids(v_project_id)
  ) THEN
    RAISE EXCEPTION 'Você não pode remover sua própria associação ao projeto.'
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.project_members AS pm
  WHERE pm.id = p_member_id
  RETURNING pm.project_id INTO v_project_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY SELECT v_project_id;
END;
$$;

REVOKE ALL ON FUNCTION public.remove_project_member(uuid)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.remove_project_member(uuid)
  TO authenticated;
