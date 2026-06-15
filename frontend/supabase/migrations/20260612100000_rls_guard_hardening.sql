-- Hardening dos guards do #178 (apontado na revisão do PR #188). As migrations
-- 20260612090000/090100/090200 já estão aplicadas em produção, então as três
-- melhorias entram aqui como migration própria:
--
-- 1) enforce_projects_column_guard: current_round_id só pode apontar para
--    round do próprio projeto — a FK simples em rounds(id) não impede ancorar
--    em round de projeto alheio (vetor da classe do #162). Vale para qualquer
--    caller com JWT, inclusive criador/master.
-- 2) enforce_schema_change_log_column_guard: deny-list vira allow-list
--    (compara to_jsonb sem as 4 chaves de classificação de versão) — coluna
--    adicionada no futuro nasce imutável por default (fail-closed), adequado
--    a log de auditoria.
-- 3) note_resolutions INSERT: amarra resolved_by ao caller. resolveNote
--    sempre grava user.id (o próprio clerk_uid(), inclusive em contas-alias —
--    a unificação da spec 002 reescreve resolved_by depois, via função
--    SECURITY DEFINER, que não passa por esta policy), então nenhum fluxo
--    legítimo insere em nome de terceiro.

-- ========== 1. projects: round do próprio projeto ==========
CREATE OR REPLACE FUNCTION enforce_projects_column_guard()
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

  -- PK imutável para qualquer caller com JWT.
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'id is immutable on projects'
      USING ERRCODE = '42501';
  END IF;

  -- current_round_id só pode apontar para round do próprio projeto — a FK
  -- simples em rounds(id) não impede ancorar em round de projeto alheio
  -- (vetor da classe do #162). Vale para qualquer caller com JWT.
  IF NEW.current_round_id IS NOT NULL
     AND NEW.current_round_id IS DISTINCT FROM OLD.current_round_id
     AND NOT EXISTS (
       SELECT 1 FROM public.rounds r
       WHERE r.id = NEW.current_round_id AND r.project_id = NEW.id
     )
  THEN
    RAISE EXCEPTION 'current_round_id must reference a round of this project'
      USING ERRCODE = '42501';
  END IF;

  -- Master mantém permissão ampla nas demais colunas.
  IF public.is_master() THEN
    RETURN NEW;
  END IF;

  -- Criador (ancorado em OLD.created_by, nunca NEW) mantém permissão ampla.
  IF OLD.created_by = uid THEN
    RETURN NEW;
  END IF;

  -- Caminho restante: coordenador-membro (entrou pela policy
  -- "Coordinators update projects"). Colunas de identidade bloqueadas.
  IF NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'Coordinators cannot change created_by/created_at on projects'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

-- ========== 2. schema_change_log: allow-list ==========
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
  -- Allow-list: qualquer diferença fora das 4 chaves abaixo bloqueia —
  -- project_id imutável fecha o vetor cross-project (lição do #162) e
  -- coluna nova fica automaticamente coberta.
  IF to_jsonb(NEW) - ARRAY['change_type', 'version_major', 'version_minor', 'version_patch']
     IS DISTINCT FROM
     to_jsonb(OLD) - ARRAY['change_type', 'version_major', 'version_minor', 'version_patch']
  THEN
    RAISE EXCEPTION
      'Only change_type/version_* are updatable on schema_change_log'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

-- ========== 3. note_resolutions: resolved_by = caller ==========
DROP POLICY "Coordinators or resolvers insert note_resolutions" ON note_resolutions;
CREATE POLICY "Coordinators or resolvers insert note_resolutions" ON note_resolutions
  FOR INSERT
  WITH CHECK (
    resolved_by = clerk_uid()
    AND (
      project_id IN (SELECT auth_user_coordinator_or_creator_project_ids())
      OR project_id IN (SELECT auth_user_resolver_project_ids())
      OR is_master()
    )
  );
