-- Replace auth.uid() with clerk_uid() across all RLS policies.
-- Clerk JWT 'sub' is a string (user_2xAbC...) that can't cast to UUID,
-- so we read the custom 'supabase_uid' claim from the JWT instead.

-- ========== 1. clerk_uid() function ==========
CREATE OR REPLACE FUNCTION clerk_uid()
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT (auth.jwt()->>'supabase_uid')::uuid
$$;

-- ========== 2. Update helper functions ==========
CREATE OR REPLACE FUNCTION auth_user_project_ids()
RETURNS SETOF UUID
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY SELECT project_id FROM public.project_members WHERE user_id = clerk_uid();
END;
$$;

CREATE OR REPLACE FUNCTION auth_user_coordinator_project_ids()
RETURNS SETOF UUID
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY SELECT project_id FROM public.project_members WHERE user_id = clerk_uid() AND role = 'coordenador';
END;
$$;

-- ========== 3. profiles ==========
DROP POLICY IF EXISTS "Users view own profile" ON profiles;
DROP POLICY IF EXISTS "Project members view teammate profiles" ON profiles;

CREATE POLICY "Users and teammates view profiles" ON profiles FOR SELECT USING (
  clerk_uid() = id
  OR EXISTS (
    SELECT 1 FROM project_members pm1
    JOIN project_members pm2 ON pm1.project_id = pm2.project_id
    WHERE pm1.user_id = clerk_uid()
      AND pm2.user_id = profiles.id
  )
);

-- ========== 4. projects ==========
DROP POLICY IF EXISTS "Members view projects" ON projects;
DROP POLICY IF EXISTS "Creator manages projects" ON projects;

CREATE POLICY "Members view projects" ON projects FOR SELECT USING (
  id IN (SELECT auth_user_project_ids())
  OR created_by = clerk_uid()
);
CREATE POLICY "Creator manages projects" ON projects FOR ALL USING (
  created_by = clerk_uid()
);

-- ========== 5. project_members ==========
DROP POLICY IF EXISTS "Members view members" ON project_members;
DROP POLICY IF EXISTS "Coordinators manage members" ON project_members;
DROP POLICY IF EXISTS "Creator inserts members" ON project_members;

CREATE POLICY "Members view members" ON project_members FOR SELECT USING (
  project_id IN (SELECT auth_user_project_ids())
);
CREATE POLICY "Coordinators manage members" ON project_members FOR ALL USING (
  project_id IN (SELECT auth_user_coordinator_project_ids())
);
CREATE POLICY "Creator inserts members" ON project_members FOR INSERT WITH CHECK (
  project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
);

-- ========== 6. documents ==========
DROP POLICY IF EXISTS "Members view documents" ON documents;
DROP POLICY IF EXISTS "Coordinators manage documents" ON documents;

CREATE POLICY "Members view documents" ON documents FOR SELECT USING (
  project_id IN (SELECT auth_user_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
);
CREATE POLICY "Coordinators manage documents" ON documents FOR ALL USING (
  project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
);

-- ========== 7. assignments ==========
DROP POLICY IF EXISTS "Members view assignments" ON assignments;
DROP POLICY IF EXISTS "Coordinators manage assignments" ON assignments;
DROP POLICY IF EXISTS "Researchers update own assignments" ON assignments;

CREATE POLICY "Members view assignments" ON assignments FOR SELECT USING (
  project_id IN (SELECT auth_user_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
);
CREATE POLICY "Coordinators manage assignments" ON assignments FOR ALL USING (
  project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
);
CREATE POLICY "Researchers update own assignments" ON assignments FOR UPDATE
  USING (user_id = clerk_uid())
  WITH CHECK (user_id = clerk_uid());

-- ========== 8. responses ==========
DROP POLICY IF EXISTS "Members view responses" ON responses;
DROP POLICY IF EXISTS "Users manage own responses" ON responses;

CREATE POLICY "Members view responses" ON responses FOR SELECT USING (
  project_id IN (SELECT auth_user_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
);
CREATE POLICY "Users manage own responses" ON responses FOR ALL USING (
  respondent_id = clerk_uid()
  OR project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
);

-- ========== 9. reviews ==========
DROP POLICY IF EXISTS "Members view reviews" ON reviews;
DROP POLICY IF EXISTS "Reviewers manage reviews" ON reviews;

CREATE POLICY "Members view reviews" ON reviews FOR SELECT USING (
  project_id IN (SELECT auth_user_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
);
CREATE POLICY "Reviewers manage reviews" ON reviews FOR ALL USING (
  reviewer_id = clerk_uid()
  OR project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
);

-- ========== 10. question_meta ==========
DROP POLICY IF EXISTS "Members view question_meta" ON question_meta;
DROP POLICY IF EXISTS "Coordinators manage question_meta" ON question_meta;

CREATE POLICY "Members view question_meta" ON question_meta FOR SELECT USING (
  project_id IN (SELECT auth_user_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
);
CREATE POLICY "Coordinators manage question_meta" ON question_meta FOR ALL USING (
  project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
);

-- ========== 11. discussions ==========
DROP POLICY IF EXISTS "Members view discussions" ON discussions;
DROP POLICY IF EXISTS "Members create discussions" ON discussions;
DROP POLICY IF EXISTS "Coordinators update discussions" ON discussions;

CREATE POLICY "Members view discussions" ON discussions FOR SELECT USING (
  project_id IN (SELECT auth_user_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
);
CREATE POLICY "Members create discussions" ON discussions FOR INSERT WITH CHECK (
  (project_id IN (SELECT auth_user_project_ids())
   OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid()))
  AND created_by = clerk_uid()
);
CREATE POLICY "Coordinators update discussions" ON discussions FOR UPDATE USING (
  project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
);

-- ========== 12. discussion_comments ==========
DROP POLICY IF EXISTS "Members view discussion_comments" ON discussion_comments;
DROP POLICY IF EXISTS "Members create discussion_comments" ON discussion_comments;
DROP POLICY IF EXISTS "Project members view comments" ON discussion_comments;
DROP POLICY IF EXISTS "Project members insert comments" ON discussion_comments;

CREATE POLICY "Members view discussion_comments" ON discussion_comments FOR SELECT USING (
  discussion_id IN (
    SELECT id FROM discussions WHERE project_id IN (SELECT auth_user_project_ids())
    OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
  )
);
CREATE POLICY "Members create discussion_comments" ON discussion_comments FOR INSERT WITH CHECK (
  discussion_id IN (
    SELECT id FROM discussions WHERE project_id IN (SELECT auth_user_project_ids())
    OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
  )
  AND created_by = clerk_uid()
);

-- ========== 13. assignment_batches ==========
DROP POLICY IF EXISTS "Members view batches" ON assignment_batches;
DROP POLICY IF EXISTS "Coordinators manage batches" ON assignment_batches;

CREATE POLICY "Members view batches" ON assignment_batches FOR SELECT USING (
  project_id IN (SELECT auth_user_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
);
CREATE POLICY "Coordinators manage batches" ON assignment_batches FOR ALL USING (
  project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
);

-- ========== 14. difficulty_resolutions ==========
DROP POLICY IF EXISTS "Members view difficulty_resolutions" ON difficulty_resolutions;
DROP POLICY IF EXISTS "Coordinators insert difficulty_resolutions" ON difficulty_resolutions;
DROP POLICY IF EXISTS "Coordinators delete difficulty_resolutions" ON difficulty_resolutions;

CREATE POLICY "Members view difficulty_resolutions" ON difficulty_resolutions FOR SELECT USING (
  project_id IN (SELECT auth_user_project_ids())
);
CREATE POLICY "Coordinators insert difficulty_resolutions" ON difficulty_resolutions FOR INSERT WITH CHECK (
  project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
);
CREATE POLICY "Coordinators delete difficulty_resolutions" ON difficulty_resolutions FOR DELETE USING (
  project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
);

-- ========== 15. error_resolutions ==========
DROP POLICY IF EXISTS "Members view error_resolutions" ON error_resolutions;
DROP POLICY IF EXISTS "Coordinators insert error_resolutions" ON error_resolutions;
DROP POLICY IF EXISTS "Coordinators delete error_resolutions" ON error_resolutions;

CREATE POLICY "Members view error_resolutions" ON error_resolutions FOR SELECT USING (
  project_id IN (SELECT auth_user_project_ids())
);
CREATE POLICY "Coordinators insert error_resolutions" ON error_resolutions FOR INSERT WITH CHECK (
  project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
);
CREATE POLICY "Coordinators delete error_resolutions" ON error_resolutions FOR DELETE USING (
  project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
);
