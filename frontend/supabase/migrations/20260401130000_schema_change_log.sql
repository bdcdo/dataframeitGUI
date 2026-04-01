CREATE TABLE schema_change_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  changed_by UUID NOT NULL REFERENCES profiles(id),
  field_name TEXT NOT NULL,
  change_summary TEXT NOT NULL,
  before_value JSONB,
  after_value JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_schema_change_log_project ON schema_change_log(project_id);

ALTER TABLE schema_change_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members view schema_change_log" ON schema_change_log FOR SELECT USING (
  project_id IN (SELECT auth_user_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
);

CREATE POLICY "Coordinators insert schema_change_log" ON schema_change_log FOR INSERT WITH CHECK (
  (project_id IN (SELECT auth_user_coordinator_project_ids())
   OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid()))
  AND changed_by = clerk_uid()
);
