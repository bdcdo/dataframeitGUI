-- Master users: super-admin access for platform owner.
-- This table is invisible to PostgREST (REVOKE ALL from API roles).
-- Only settable via direct SQL or service_role.

-- ========== 1. Table ==========
CREATE TABLE master_users (
  user_id UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE
);
REVOKE ALL ON master_users FROM anon, authenticated;

-- ========== 2. is_master() function ==========
CREATE OR REPLACE FUNCTION public.is_master()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.master_users WHERE user_id = public.clerk_uid()
  )
$$;

GRANT EXECUTE ON FUNCTION public.is_master() TO anon, authenticated, service_role;

-- ========== 3. Update RLS policies: profiles ==========
DROP POLICY IF EXISTS "Users and teammates view profiles" ON profiles;
CREATE POLICY "Users and teammates view profiles" ON profiles FOR SELECT USING (
  clerk_uid() = id
  OR EXISTS (
    SELECT 1 FROM project_members pm1
    JOIN project_members pm2 ON pm1.project_id = pm2.project_id
    WHERE pm1.user_id = clerk_uid()
      AND pm2.user_id = profiles.id
  )
  OR is_master()
);

-- ========== 4. Update RLS policies: projects ==========
DROP POLICY IF EXISTS "Members view projects" ON projects;
CREATE POLICY "Members view projects" ON projects FOR SELECT USING (
  id IN (SELECT auth_user_project_ids())
  OR created_by = clerk_uid()
  OR is_master()
);

DROP POLICY IF EXISTS "Creator manages projects" ON projects;
CREATE POLICY "Creator manages projects" ON projects FOR ALL USING (
  created_by = clerk_uid()
  OR is_master()
);

-- ========== 5. Update RLS policies: project_members ==========
DROP POLICY IF EXISTS "Members view members" ON project_members;
CREATE POLICY "Members view members" ON project_members FOR SELECT USING (
  project_id IN (SELECT auth_user_project_ids())
  OR is_master()
);

DROP POLICY IF EXISTS "Coordinators manage members" ON project_members;
CREATE POLICY "Coordinators manage members" ON project_members FOR ALL USING (
  project_id IN (SELECT auth_user_coordinator_project_ids())
  OR is_master()
);

DROP POLICY IF EXISTS "Creator inserts members" ON project_members;
CREATE POLICY "Creator inserts members" ON project_members FOR INSERT WITH CHECK (
  project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
  OR is_master()
);

-- ========== 6. Update RLS policies: documents ==========
DROP POLICY IF EXISTS "Members view documents" ON documents;
CREATE POLICY "Members view documents" ON documents FOR SELECT USING (
  project_id IN (SELECT auth_user_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
  OR is_master()
);

DROP POLICY IF EXISTS "Coordinators manage documents" ON documents;
CREATE POLICY "Coordinators manage documents" ON documents FOR ALL USING (
  project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
  OR is_master()
);

-- ========== 7. Update RLS policies: assignments ==========
DROP POLICY IF EXISTS "Members view assignments" ON assignments;
CREATE POLICY "Members view assignments" ON assignments FOR SELECT USING (
  project_id IN (SELECT auth_user_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
  OR is_master()
);

DROP POLICY IF EXISTS "Coordinators manage assignments" ON assignments;
CREATE POLICY "Coordinators manage assignments" ON assignments FOR ALL USING (
  project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
  OR is_master()
);
-- "Researchers update own assignments" stays unchanged (personal policy)

-- ========== 8. Update RLS policies: responses ==========
DROP POLICY IF EXISTS "Members view responses" ON responses;
CREATE POLICY "Members view responses" ON responses FOR SELECT USING (
  project_id IN (SELECT auth_user_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
  OR is_master()
);

DROP POLICY IF EXISTS "Users manage own responses" ON responses;
CREATE POLICY "Users manage own responses" ON responses FOR ALL USING (
  respondent_id = clerk_uid()
  OR project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
  OR is_master()
);

-- ========== 9. Update RLS policies: reviews ==========
DROP POLICY IF EXISTS "Members view reviews" ON reviews;
CREATE POLICY "Members view reviews" ON reviews FOR SELECT USING (
  project_id IN (SELECT auth_user_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
  OR is_master()
);

DROP POLICY IF EXISTS "Reviewers manage reviews" ON reviews;
CREATE POLICY "Reviewers manage reviews" ON reviews FOR ALL USING (
  reviewer_id = clerk_uid()
  OR project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
  OR is_master()
);

-- ========== 10. Update RLS policies: question_meta ==========
DROP POLICY IF EXISTS "Members view question_meta" ON question_meta;
CREATE POLICY "Members view question_meta" ON question_meta FOR SELECT USING (
  project_id IN (SELECT auth_user_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
  OR is_master()
);

DROP POLICY IF EXISTS "Coordinators manage question_meta" ON question_meta;
CREATE POLICY "Coordinators manage question_meta" ON question_meta FOR ALL USING (
  project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
  OR is_master()
);

-- ========== 11. Update RLS policies: assignment_batches ==========
DROP POLICY IF EXISTS "Members view batches" ON assignment_batches;
CREATE POLICY "Members view batches" ON assignment_batches FOR SELECT USING (
  project_id IN (SELECT auth_user_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
  OR is_master()
);

DROP POLICY IF EXISTS "Coordinators manage batches" ON assignment_batches;
CREATE POLICY "Coordinators manage batches" ON assignment_batches FOR ALL USING (
  project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
  OR is_master()
);

-- ========== 12. Update RLS policies: difficulty_resolutions ==========
DROP POLICY IF EXISTS "Members view difficulty_resolutions" ON difficulty_resolutions;
CREATE POLICY "Members view difficulty_resolutions" ON difficulty_resolutions FOR SELECT USING (
  project_id IN (SELECT auth_user_project_ids())
  OR is_master()
);

DROP POLICY IF EXISTS "Coordinators insert difficulty_resolutions" ON difficulty_resolutions;
CREATE POLICY "Coordinators insert difficulty_resolutions" ON difficulty_resolutions FOR INSERT WITH CHECK (
  project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
  OR is_master()
);

DROP POLICY IF EXISTS "Coordinators delete difficulty_resolutions" ON difficulty_resolutions;
CREATE POLICY "Coordinators delete difficulty_resolutions" ON difficulty_resolutions FOR DELETE USING (
  project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
  OR is_master()
);

-- ========== 13. Update RLS policies: error_resolutions ==========
DROP POLICY IF EXISTS "Members view error_resolutions" ON error_resolutions;
CREATE POLICY "Members view error_resolutions" ON error_resolutions FOR SELECT USING (
  project_id IN (SELECT auth_user_project_ids())
  OR is_master()
);

DROP POLICY IF EXISTS "Coordinators insert error_resolutions" ON error_resolutions;
CREATE POLICY "Coordinators insert error_resolutions" ON error_resolutions FOR INSERT WITH CHECK (
  project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
  OR is_master()
);

DROP POLICY IF EXISTS "Coordinators delete error_resolutions" ON error_resolutions;
CREATE POLICY "Coordinators delete error_resolutions" ON error_resolutions FOR DELETE USING (
  project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
  OR is_master()
);

-- ========== 14. Update RLS policies: schema_change_log ==========
DROP POLICY IF EXISTS "Members view schema_change_log" ON schema_change_log;
CREATE POLICY "Members view schema_change_log" ON schema_change_log FOR SELECT USING (
  project_id IN (SELECT auth_user_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
  OR is_master()
);

DROP POLICY IF EXISTS "Coordinators insert schema_change_log" ON schema_change_log;
CREATE POLICY "Coordinators insert schema_change_log" ON schema_change_log FOR INSERT WITH CHECK (
  (project_id IN (SELECT auth_user_coordinator_project_ids())
   OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
   OR is_master())
  AND changed_by = clerk_uid()
);

-- ========== 15. Update RLS policies: schema_suggestions ==========
DROP POLICY IF EXISTS "Members can view suggestions" ON schema_suggestions;
CREATE POLICY "Members can view suggestions" ON schema_suggestions FOR SELECT USING (
  project_id IN (SELECT project_id FROM project_members WHERE user_id = clerk_uid())
  OR is_master()
);

DROP POLICY IF EXISTS "Members can create suggestions" ON schema_suggestions;
CREATE POLICY "Members can create suggestions" ON schema_suggestions FOR INSERT WITH CHECK (
  project_id IN (SELECT project_id FROM project_members WHERE user_id = clerk_uid())
  OR is_master()
);

DROP POLICY IF EXISTS "Coordinators can update suggestions" ON schema_suggestions;
CREATE POLICY "Coordinators can update suggestions" ON schema_suggestions FOR UPDATE USING (
  project_id IN (
    SELECT project_id FROM project_members
    WHERE user_id = clerk_uid() AND role = 'coordenador'
  )
  OR is_master()
);

-- ========== 16. Update RLS policies: verdict_acknowledgments ==========
DROP POLICY IF EXISTS "Members can view acknowledgments" ON verdict_acknowledgments;
CREATE POLICY "Members can view acknowledgments" ON verdict_acknowledgments FOR SELECT USING (
  review_id IN (
    SELECT id FROM reviews WHERE project_id IN (
      SELECT project_id FROM project_members WHERE user_id = clerk_uid()
    )
  )
  OR is_master()
);
-- "Respondents can upsert/update own acknowledgments" stay unchanged (personal policies)
