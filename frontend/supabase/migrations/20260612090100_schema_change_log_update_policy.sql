-- #178 (achado da auditoria): schema_change_log só tinha policies de INSERT e
-- SELECT — o passo 2 do backfillSchemaVersionHistory (reclassificar
-- change_type/version_* de cada entrada) era silent no-op para TODOS os
-- papéis, inclusive criador e master, e o toast reportava sucesso falso.
--
-- Libera UPDATE para coordenador/criador/master e tranca por trigger todas as
-- colunas exceto as 4 de classificação de versão (as únicas que o backfill
-- toca) — preserva a natureza de log de auditoria: before/after_value,
-- changed_by, field_name, change_summary, created_at, project_id e id são
-- imutáveis via JWT. Manutenção excepcional usa service role, que bypassa.

CREATE POLICY "Coordinators update schema_change_log" ON schema_change_log
  FOR UPDATE
  USING (
    project_id IN (SELECT auth_user_coordinator_or_creator_project_ids())
    OR is_master()
  )
  WITH CHECK (
    project_id IN (SELECT auth_user_coordinator_or_creator_project_ids())
    OR is_master()
  );

CREATE OR REPLACE FUNCTION enforce_schema_change_log_column_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Sem JWT do Clerk (service role, migrations) bypassa.
  IF public.clerk_uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- Log de auditoria: via JWT, só a classificação de versão é mutável.
  -- project_id imutável fecha o vetor cross-project (lição do #162).
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.changed_by IS DISTINCT FROM OLD.changed_by
     OR NEW.field_name IS DISTINCT FROM OLD.field_name
     OR NEW.change_summary IS DISTINCT FROM OLD.change_summary
     OR NEW.before_value IS DISTINCT FROM OLD.before_value
     OR NEW.after_value IS DISTINCT FROM OLD.after_value
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'Only change_type/version_* are updatable on schema_change_log'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_schema_change_log_column_guard_trigger ON schema_change_log;
CREATE TRIGGER enforce_schema_change_log_column_guard_trigger
  BEFORE UPDATE ON schema_change_log
  FOR EACH ROW
  EXECUTE FUNCTION enforce_schema_change_log_column_guard();
