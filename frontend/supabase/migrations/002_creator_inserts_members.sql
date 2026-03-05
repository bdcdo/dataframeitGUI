-- Fix chicken-and-egg: allow project creator to insert members
CREATE POLICY "Creator inserts members" ON project_members FOR INSERT WITH CHECK (
  project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
);
