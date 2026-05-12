-- Unifica padrões repetidos em RLS policies (definidas em 20260402000000_master_users.sql):
--
--   (a) "Members view X"  →  IN (auth_user_project_ids()) OR IN (projects WHERE created_by = clerk_uid())
--       Colapsado em auth_user_accessible_project_ids() (UNION inlineável).
--
--   (b) "Coordinators manage X"  →  IN (auth_user_coordinator_project_ids()) OR IN (projects WHERE created_by = clerk_uid())
--       Colapsado em auth_user_coordinator_or_creator_project_ids() (UNION inlineável).
--
-- A cláusula `OR is_master()` é preservada fora da função para manter o curto-circuito
-- do planner para usuários master.
--
-- Também migra auth_user_project_ids() e auth_user_coordinator_project_ids() de
-- plpgsql para sql (LANGUAGE sql STABLE), tornando-as inlineáveis em todas as
-- policies preservadas (projects, project_members, verdict_acknowledgments, etc.).

-- ========== 1. Funções unificadas (LANGUAGE sql, inlineáveis) ==========
CREATE OR REPLACE FUNCTION auth_user_accessible_project_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT project_id FROM public.project_members WHERE user_id = public.clerk_uid()
  UNION
  SELECT id FROM public.projects WHERE created_by = public.clerk_uid()
$$;

GRANT EXECUTE ON FUNCTION auth_user_accessible_project_ids() TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION auth_user_coordinator_or_creator_project_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT project_id FROM public.project_members
    WHERE user_id = public.clerk_uid() AND role = 'coordenador'
  UNION
  SELECT id FROM public.projects WHERE created_by = public.clerk_uid()
$$;

GRANT EXECUTE ON FUNCTION auth_user_coordinator_or_creator_project_ids() TO anon, authenticated, service_role;

-- Reescrever as funções antigas como LANGUAGE sql (assinatura idêntica → sem
-- impacto em database.types.ts). Inlineável pelo planner; suaviza o custo das
-- policies que ainda as chamam diretamente (projects, project_members,
-- verdict_acknowledgments, schema_suggestions).
CREATE OR REPLACE FUNCTION auth_user_project_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT project_id FROM public.project_members WHERE user_id = public.clerk_uid()
$$;

CREATE OR REPLACE FUNCTION auth_user_coordinator_project_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT project_id FROM public.project_members
    WHERE user_id = public.clerk_uid() AND role = 'coordenador'
$$;

-- ========== 2. documents ==========
DROP POLICY IF EXISTS "Members view documents" ON documents;
DROP POLICY IF EXISTS "Coordinators manage documents" ON documents;

CREATE POLICY "Members view documents" ON documents FOR SELECT USING (
  project_id IN (SELECT auth_user_accessible_project_ids())
  OR is_master()
);
CREATE POLICY "Coordinators manage documents" ON documents FOR ALL USING (
  project_id IN (SELECT auth_user_coordinator_or_creator_project_ids())
  OR is_master()
);

-- ========== 3. assignments ==========
DROP POLICY IF EXISTS "Members view assignments" ON assignments;
DROP POLICY IF EXISTS "Coordinators manage assignments" ON assignments;

CREATE POLICY "Members view assignments" ON assignments FOR SELECT USING (
  project_id IN (SELECT auth_user_accessible_project_ids())
  OR is_master()
);
CREATE POLICY "Coordinators manage assignments" ON assignments FOR ALL USING (
  project_id IN (SELECT auth_user_coordinator_or_creator_project_ids())
  OR is_master()
);

-- ========== 4. responses ==========
DROP POLICY IF EXISTS "Members view responses" ON responses;
DROP POLICY IF EXISTS "Users manage own responses" ON responses;

CREATE POLICY "Members view responses" ON responses FOR SELECT USING (
  project_id IN (SELECT auth_user_accessible_project_ids())
  OR is_master()
);
CREATE POLICY "Users manage own responses" ON responses FOR ALL USING (
  respondent_id = clerk_uid()
  OR project_id IN (SELECT auth_user_coordinator_or_creator_project_ids())
  OR is_master()
);

-- ========== 5. reviews ==========
DROP POLICY IF EXISTS "Members view reviews" ON reviews;
DROP POLICY IF EXISTS "Reviewers manage reviews" ON reviews;

CREATE POLICY "Members view reviews" ON reviews FOR SELECT USING (
  project_id IN (SELECT auth_user_accessible_project_ids())
  OR is_master()
);
CREATE POLICY "Reviewers manage reviews" ON reviews FOR ALL USING (
  reviewer_id = clerk_uid()
  OR project_id IN (SELECT auth_user_coordinator_or_creator_project_ids())
  OR is_master()
);

-- ========== 6. question_meta ==========
DROP POLICY IF EXISTS "Members view question_meta" ON question_meta;
DROP POLICY IF EXISTS "Coordinators manage question_meta" ON question_meta;

CREATE POLICY "Members view question_meta" ON question_meta FOR SELECT USING (
  project_id IN (SELECT auth_user_accessible_project_ids())
  OR is_master()
);
CREATE POLICY "Coordinators manage question_meta" ON question_meta FOR ALL USING (
  project_id IN (SELECT auth_user_coordinator_or_creator_project_ids())
  OR is_master()
);

-- Seções 7 e 8 removidas: tabelas `discussions` e `discussion_comments` foram
-- dropadas em 20260401120000_drop_discussions.sql. As policies originais em
-- 20260401100000_clerk_uid_rls.sql e 20260317150000_fix_discussions_rls_creator.sql
-- já não têm efeito desde então.

-- ========== 7. assignment_batches ==========
DROP POLICY IF EXISTS "Members view batches" ON assignment_batches;
DROP POLICY IF EXISTS "Coordinators manage batches" ON assignment_batches;

CREATE POLICY "Members view batches" ON assignment_batches FOR SELECT USING (
  project_id IN (SELECT auth_user_accessible_project_ids())
  OR is_master()
);
CREATE POLICY "Coordinators manage batches" ON assignment_batches FOR ALL USING (
  project_id IN (SELECT auth_user_coordinator_or_creator_project_ids())
  OR is_master()
);

-- ========== 8. difficulty_resolutions (SELECT permanece restrito a membros) ==========
DROP POLICY IF EXISTS "Coordinators insert difficulty_resolutions" ON difficulty_resolutions;
DROP POLICY IF EXISTS "Coordinators delete difficulty_resolutions" ON difficulty_resolutions;

CREATE POLICY "Coordinators insert difficulty_resolutions" ON difficulty_resolutions FOR INSERT WITH CHECK (
  project_id IN (SELECT auth_user_coordinator_or_creator_project_ids())
  OR is_master()
);
CREATE POLICY "Coordinators delete difficulty_resolutions" ON difficulty_resolutions FOR DELETE USING (
  project_id IN (SELECT auth_user_coordinator_or_creator_project_ids())
  OR is_master()
);

-- ========== 9. error_resolutions (SELECT permanece restrito a membros) ==========
DROP POLICY IF EXISTS "Coordinators insert error_resolutions" ON error_resolutions;
DROP POLICY IF EXISTS "Coordinators delete error_resolutions" ON error_resolutions;

CREATE POLICY "Coordinators insert error_resolutions" ON error_resolutions FOR INSERT WITH CHECK (
  project_id IN (SELECT auth_user_coordinator_or_creator_project_ids())
  OR is_master()
);
CREATE POLICY "Coordinators delete error_resolutions" ON error_resolutions FOR DELETE USING (
  project_id IN (SELECT auth_user_coordinator_or_creator_project_ids())
  OR is_master()
);

-- ========== 10. schema_change_log ==========
DROP POLICY IF EXISTS "Members view schema_change_log" ON schema_change_log;
CREATE POLICY "Members view schema_change_log" ON schema_change_log FOR SELECT USING (
  project_id IN (SELECT auth_user_accessible_project_ids())
  OR is_master()
);

DROP POLICY IF EXISTS "Coordinators insert schema_change_log" ON schema_change_log;
CREATE POLICY "Coordinators insert schema_change_log" ON schema_change_log FOR INSERT WITH CHECK (
  (project_id IN (SELECT auth_user_coordinator_or_creator_project_ids())
   OR is_master())
  AND changed_by = clerk_uid()
);
