-- project_members.can_resolve: flag por membro controlando se ele pode
-- marcar como resolvido itens que hoje só coordenador resolve — dificuldades
-- LLM (difficulty_resolutions), erros LLM (error_resolutions) e comentários
-- de outros pesquisadores (project_comments).
--
-- Default false: novos membros entram sem essa permissão; coordenador
-- habilita explicitamente quem deve assumir a triagem.
--
-- Backfill true: preserva o desbloqueio imediato em projetos já em produção
-- onde pesquisadoras estavam batendo em "new row violates row-level security
-- policy for table difficulty_resolutions" e "Sem permissão para resolver
-- este comentário" ao tentar resolver itens de máquina ou comentários de
-- colegas. Coordenador pode revogar depois caso a caso.

ALTER TABLE project_members
  ADD COLUMN can_resolve BOOLEAN NOT NULL DEFAULT false;

UPDATE project_members SET can_resolve = true;

-- Index parcial: as policies abaixo filtram por (project_id, can_resolve=true).
-- Em projetos com muitos membros e poucos resolvedores explícitos, o index
-- parcial é mais compacto que um btree completo.
CREATE INDEX idx_project_members_resolvers
  ON project_members (project_id)
  WHERE can_resolve = true;

-- Helper inlineável análoga a auth_user_coordinator_or_creator_project_ids()
-- e auth_user_accessible_project_ids() (ver 20260512000000_rls_unified_project_access.sql).
-- LANGUAGE sql + STABLE + SECURITY DEFINER para o planner inline e evitar
-- recursão em RLS.
CREATE OR REPLACE FUNCTION auth_user_resolver_project_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT project_id FROM public.project_members
    WHERE user_id = public.clerk_uid() AND can_resolve = true
$$;

GRANT EXECUTE ON FUNCTION auth_user_resolver_project_ids() TO anon, authenticated, service_role;

-- ========== difficulty_resolutions ==========
-- Estende INSERT/DELETE para reconhecer membros com can_resolve=true além
-- de coordenadores. SELECT permanece intocada (qualquer membro continua
-- vendo o histórico de resoluções).
DROP POLICY IF EXISTS "Coordinators insert difficulty_resolutions" ON difficulty_resolutions;
CREATE POLICY "Coordinators insert difficulty_resolutions" ON difficulty_resolutions FOR INSERT WITH CHECK (
  project_id IN (SELECT auth_user_coordinator_or_creator_project_ids())
  OR project_id IN (SELECT auth_user_resolver_project_ids())
  OR is_master()
);

DROP POLICY IF EXISTS "Coordinators delete difficulty_resolutions" ON difficulty_resolutions;
CREATE POLICY "Coordinators delete difficulty_resolutions" ON difficulty_resolutions FOR DELETE USING (
  project_id IN (SELECT auth_user_coordinator_or_creator_project_ids())
  OR project_id IN (SELECT auth_user_resolver_project_ids())
  OR is_master()
);

-- ========== error_resolutions ==========
DROP POLICY IF EXISTS "Coordinators insert error_resolutions" ON error_resolutions;
CREATE POLICY "Coordinators insert error_resolutions" ON error_resolutions FOR INSERT WITH CHECK (
  project_id IN (SELECT auth_user_coordinator_or_creator_project_ids())
  OR project_id IN (SELECT auth_user_resolver_project_ids())
  OR is_master()
);

DROP POLICY IF EXISTS "Coordinators delete error_resolutions" ON error_resolutions;
CREATE POLICY "Coordinators delete error_resolutions" ON error_resolutions FOR DELETE USING (
  project_id IN (SELECT auth_user_coordinator_or_creator_project_ids())
  OR project_id IN (SELECT auth_user_resolver_project_ids())
  OR is_master()
);

-- ========== project_comments ==========
-- Caminho adicional para UPDATE: membro com can_resolve=true pode atualizar
-- qualquer comentário do projeto (cobre o caso "resolver comentário de outro
-- pesquisador"). As duas policies pré-existentes ("Coordinators can update"
-- e "Authors can update own") permanecem como caminhos paralelos.
DROP POLICY IF EXISTS "Resolvers can update project comments" ON project_comments;
CREATE POLICY "Resolvers can update project comments" ON project_comments
  FOR UPDATE
  USING (
    project_id IN (SELECT auth_user_resolver_project_ids())
  )
  WITH CHECK (
    project_id IN (SELECT auth_user_resolver_project_ids())
  );
