-- Fix: allow project creators (not just coordinators) to resolve/reopen discussions
DROP POLICY IF EXISTS "Coordinators update discussions" ON discussions;
CREATE POLICY "Coordinators update discussions" ON discussions FOR UPDATE USING (
  project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
);
