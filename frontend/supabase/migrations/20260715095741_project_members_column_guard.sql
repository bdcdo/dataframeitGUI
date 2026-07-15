-- Defesa em profundidade para project_members: a RLS decide quem pode atualizar
-- a linha; este guard impede que um membro autorizado a gerenciar o projeto
-- mude o próprio papel e, com isso, contorne a decisão de produto sobre
-- autoalteração. As flags can_resolve/can_arbitrate/can_compare permanecem
-- editáveis na própria linha.

CREATE OR REPLACE FUNCTION public.enforce_project_members_column_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid UUID;
BEGIN
  uid := public.clerk_uid();

  -- Sem JWT do Clerk (service role, migrations, scripts admin) bypassa.
  IF uid IS NULL THEN
    RETURN NEW;
  END IF;

  -- Master mantém permissão ampla, inclusive para alterar o próprio papel.
  IF public.is_master() THEN
    RETURN NEW;
  END IF;

  -- OLD.project_id ancora a identidade no projeto onde a linha vive. O helper
  -- canônico inclui tanto o UUID do JWT quanto o member_user_id exercido por
  -- uma conta-alias (spec 002), sem duplicar aqui a lógica de vínculo.
  IF NEW.role IS DISTINCT FROM OLD.role
     AND OLD.user_id IN (
       SELECT public.auth_user_member_identity_ids(OLD.project_id)
     )
  THEN
    RAISE EXCEPTION 'Members cannot change their own role on project_members'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_project_members_column_guard_trigger ON public.project_members;
CREATE TRIGGER enforce_project_members_column_guard_trigger
  BEFORE UPDATE ON public.project_members
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_project_members_column_guard();

-- Não há trigger de INSERT: o bootstrap criador -> coordenador é autorizado na
-- origem pela policy "Creator inserts members" e não possui estado OLD a proteger.
