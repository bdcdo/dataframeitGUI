-- #178: coordenadores não-criadores não conseguiam salvar schema, prompt,
-- config LLM, regras nem rodadas — a única policy de escrita em projects era
-- "Creator manages projects" (FOR ALL, created_by = clerk_uid() OR is_master()),
-- e o PostgREST devolve sucesso com 0 linhas quando a RLS filtra o UPDATE
-- (silent no-op). A UI já oferece todos esses fluxos a coordenadores; o INSERT
-- em schema_change_log tem braço de coordenador e passava, gerando histórico
-- "fantasma" de mudanças que o schema nunca recebeu.
--
-- Conserto: braço de UPDATE para coordenador + column guard via trigger
-- (padrão de 20260527130000/20260527140000) protegendo as colunas de
-- identidade. Criador e master mantêm o comportamento atual (early-returns).
-- DELETE e INSERT de projects continuam criador/master-only — nenhum braço
-- novo é criado para eles.

-- 1) Braço de UPDATE para coordenador-membro (criador/master já cobertos
--    pela policy "Creator manages projects", intocada).
CREATE POLICY "Coordinators update projects" ON projects
  FOR UPDATE
  USING (id IN (SELECT auth_user_coordinator_or_creator_project_ids()))
  WITH CHECK (id IN (SELECT auth_user_coordinator_or_creator_project_ids()));

-- 2) Column guard. Classificação das colunas:
--    - id: imutável para QUALQUER caller com JWT (inclusive criador/master) —
--      mudar a PK re-ancora a linha nas policies, vetor da classe do #162.
--    - created_by, created_at: criador/master-only (transferir ownership
--      seria escalação de privilégio; created_at é metadado de auditoria).
--    - Todas as demais (name, description, pydantic_*, prompt_template,
--      llm_*, resolution_rule, min_responses_for_comparison,
--      allow_researcher_review, arbitration_blind, schema_version_*,
--      round_strategy, current_round_id): coordenador-editáveis — cada uma
--      corresponde a um fluxo de UI já oferecido a coordenadores.
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

DROP TRIGGER IF EXISTS enforce_projects_column_guard_trigger ON projects;
CREATE TRIGGER enforce_projects_column_guard_trigger
  BEFORE UPDATE ON projects
  FOR EACH ROW
  EXECUTE FUNCTION enforce_projects_column_guard();
