-- Fix E: Add creator fallback to discussions RLS policies
-- Creators of a project who are not in project_members should still access discussions

-- discussions: SELECT
DROP POLICY IF EXISTS "Members view discussions" ON discussions;
CREATE POLICY "Members view discussions" ON discussions FOR SELECT USING (
  project_id IN (SELECT auth_user_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
);

-- discussions: INSERT
DROP POLICY IF EXISTS "Members create discussions" ON discussions;
CREATE POLICY "Members create discussions" ON discussions FOR INSERT WITH CHECK (
  (project_id IN (SELECT auth_user_project_ids())
   OR project_id IN (SELECT id FROM projects WHERE created_by = auth.uid()))
  AND created_by = auth.uid()
);

-- discussion_comments: SELECT
DROP POLICY IF EXISTS "Members view discussion_comments" ON discussion_comments;
CREATE POLICY "Members view discussion_comments" ON discussion_comments FOR SELECT USING (
  discussion_id IN (
    SELECT id FROM discussions WHERE project_id IN (SELECT auth_user_project_ids())
    OR project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
  )
);

-- discussion_comments: INSERT
DROP POLICY IF EXISTS "Members create discussion_comments" ON discussion_comments;
CREATE POLICY "Members create discussion_comments" ON discussion_comments FOR INSERT WITH CHECK (
  discussion_id IN (
    SELECT id FROM discussions WHERE project_id IN (SELECT auth_user_project_ids())
    OR project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
  )
  AND created_by = auth.uid()
);
