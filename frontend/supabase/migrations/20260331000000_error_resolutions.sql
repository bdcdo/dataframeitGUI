-- Table for resolving LLM error mismatches (LLM answer ≠ chosen verdict)
-- Keyed by (project_id, document_id, field_name) since errors are computed, not stored
CREATE TABLE error_resolutions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id   UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  field_name    TEXT NOT NULL,
  resolved_by   UUID NOT NULL REFERENCES profiles(id),
  resolved_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  note          TEXT,
  discussion_id UUID REFERENCES discussions(id),
  UNIQUE(project_id, document_id, field_name)
);

CREATE INDEX idx_error_resolutions_project ON error_resolutions(project_id);

ALTER TABLE error_resolutions ENABLE ROW LEVEL SECURITY;

-- Any project member can view error resolutions
CREATE POLICY "Members view error_resolutions" ON error_resolutions FOR SELECT USING (
  project_id IN (SELECT auth_user_project_ids())
);

-- Coordinators can insert error resolutions
CREATE POLICY "Coordinators insert error_resolutions" ON error_resolutions FOR INSERT WITH CHECK (
  project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
);

-- Coordinators can delete error resolutions (reopen)
CREATE POLICY "Coordinators delete error_resolutions" ON error_resolutions FOR DELETE USING (
  project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
);
