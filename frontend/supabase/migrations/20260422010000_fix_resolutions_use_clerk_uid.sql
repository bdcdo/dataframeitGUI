-- Fix: replace auth.uid() with clerk_uid() in recently-added policies.
-- Under Clerk third-party auth the JWT 'sub' claim is the Clerk ID
-- (user_...), which auth.uid() casts to UUID and fails with
-- "invalid input syntax for type uuid: 'user_...'". clerk_uid() reads
-- the custom 'supabase_uid' claim instead (convention from
-- 20260401100000_clerk_uid_rls.sql).

-- note_resolutions
DROP POLICY IF EXISTS "Coordinators insert note_resolutions" ON note_resolutions;
DROP POLICY IF EXISTS "Coordinators delete note_resolutions" ON note_resolutions;

CREATE POLICY "Coordinators insert note_resolutions" ON note_resolutions FOR INSERT WITH CHECK (
  project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
);
CREATE POLICY "Coordinators delete note_resolutions" ON note_resolutions FOR DELETE USING (
  project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
);

-- verdict_acknowledgments
DROP POLICY IF EXISTS "Coordinators can update verdict_acknowledgments" ON verdict_acknowledgments;

CREATE POLICY "Coordinators can update verdict_acknowledgments" ON verdict_acknowledgments
  FOR UPDATE USING (
    review_id IN (
      SELECT id FROM reviews
      WHERE project_id IN (SELECT auth_user_coordinator_project_ids())
         OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
    )
  );
