-- Restringe resolvers-puros (com can_resolve=true mas sem ser coordenador
-- nem autor do comentário) a alterar APENAS resolved_at / resolved_by em
-- project_comments. A policy "Resolvers can update project comments" criada
-- em 20260527120000_project_members_can_resolve.sql usa só WITH CHECK, que
-- não consegue comparar OLD vs NEW; sem este guard, um resolver hostil
-- poderia, via REST direta do Supabase, modificar body/author_id/kind/etc.
-- de comentários de outros pesquisadores. Trigger BEFORE UPDATE preenche
-- essa lacuna.
--
-- Caminhos NÃO bloqueados (mantêm permissão ampla):
--   - coordenador do projeto (via auth_user_coordinator_or_creator_project_ids)
--   - autor do próprio comentário (OLD.author_id = clerk_uid())
--   - master (is_master())
--   - service role / migrations (clerk_uid() retorna NULL)

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

  -- Sem JWT do Clerk (service role, migrations, cron internas) bypassa.
  IF uid IS NULL THEN
    RETURN NEW;
  END IF;

  -- Coord / autor / master mantêm permissão ampla. As policies de cada
  -- caminho já autorizaram o UPDATE em si; este trigger só adiciona o gate
  -- para o caminho de resolver puro.
  IF public.is_master()
     OR OLD.author_id = uid
     OR NEW.project_id IN (
       SELECT public.auth_user_coordinator_or_creator_project_ids()
     )
  THEN
    RETURN NEW;
  END IF;

  -- Caminho restante: resolver puro (chegou aqui via policy
  -- "Resolvers can update project comments"). Bloqueia qualquer mudança
  -- fora de resolved_at / resolved_by.
  IF NEW.body IS DISTINCT FROM OLD.body
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.parent_id IS DISTINCT FROM OLD.parent_id
     OR NEW.author_id IS DISTINCT FROM OLD.author_id
     OR NEW.document_id IS DISTINCT FROM OLD.document_id
     OR NEW.field_name IS DISTINCT FROM OLD.field_name
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.rejected_at IS DISTINCT FROM OLD.rejected_at
     OR NEW.rejected_reason IS DISTINCT FROM OLD.rejected_reason
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.id IS DISTINCT FROM OLD.id
  THEN
    RAISE EXCEPTION
      'Resolvers can only change resolved_at / resolved_by on project_comments'
      USING ERRCODE = '42501';  -- insufficient_privilege
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_resolver_column_guard_trigger ON project_comments;
CREATE TRIGGER enforce_resolver_column_guard_trigger
  BEFORE UPDATE ON project_comments
  FOR EACH ROW
  EXECUTE FUNCTION enforce_resolver_column_guard();
