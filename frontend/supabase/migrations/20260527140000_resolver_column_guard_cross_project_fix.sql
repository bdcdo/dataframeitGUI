-- Conserta brecha no enforce_resolver_column_guard() introduzido em
-- 20260527130000. O gate de coordenador conferia NEW.project_id, então um
-- resolver-puro no projeto A que também fosse coordenador no projeto B
-- poderia setar NEW.project_id = B e o trigger liberava a edição —
-- sequestrando o comentário para outro projeto e burlando o gate de colunas.
--
-- Conserto:
--   1. Confere coord usando OLD.project_id (a casa onde o comentário vive).
--   2. project_id passa a ser imutável para qualquer caller não-master.
--   3. Ordem dos checks reescrita em early-returns para ficar mais óbvia.

CREATE OR REPLACE FUNCTION enforce_resolver_column_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid UUID;
BEGIN
  uid := public.clerk_uid();

  -- Sem JWT do Clerk (service role, migrations) bypassa.
  IF uid IS NULL THEN
    RETURN NEW;
  END IF;

  -- Master mantém permissão ampla.
  IF public.is_master() THEN
    RETURN NEW;
  END IF;

  -- project_id é imutável para qualquer não-master. Bloqueia a tentativa
  -- de mover o comentário entre projetos (vetor da brecha conserto).
  IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'project_id is immutable on project_comments'
      USING ERRCODE = '42501';
  END IF;

  -- Coord do projeto onde o comentário vive (OLD.project_id, não NEW).
  IF OLD.project_id IN (
    SELECT public.auth_user_coordinator_or_creator_project_ids()
  ) THEN
    RETURN NEW;
  END IF;

  -- Autor do próprio comentário.
  IF OLD.author_id = uid THEN
    RETURN NEW;
  END IF;

  -- Caminho restante: resolver-puro. Bloqueia mudança fora de
  -- resolved_at / resolved_by.
  IF NEW.body IS DISTINCT FROM OLD.body
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.parent_id IS DISTINCT FROM OLD.parent_id
     OR NEW.author_id IS DISTINCT FROM OLD.author_id
     OR NEW.document_id IS DISTINCT FROM OLD.document_id
     OR NEW.field_name IS DISTINCT FROM OLD.field_name
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.rejected_at IS DISTINCT FROM OLD.rejected_at
     OR NEW.rejected_reason IS DISTINCT FROM OLD.rejected_reason
     OR NEW.id IS DISTINCT FROM OLD.id
  THEN
    RAISE EXCEPTION
      'Resolvers can only change resolved_at / resolved_by on project_comments'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;
