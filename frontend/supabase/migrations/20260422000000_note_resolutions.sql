-- Table for resolving researcher notes (justifications._notes in responses)
-- Notes live inside responses.justifications JSONB, so they have no entity of their own
CREATE TABLE note_resolutions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  response_id  UUID NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  resolved_by  UUID NOT NULL REFERENCES profiles(id),
  resolved_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  note         TEXT,
  UNIQUE(project_id, response_id)
);

CREATE INDEX idx_note_resolutions_project ON note_resolutions(project_id);
CREATE INDEX idx_note_resolutions_response ON note_resolutions(response_id);

ALTER TABLE note_resolutions ENABLE ROW LEVEL SECURITY;

-- Any project member can view note resolutions
CREATE POLICY "Members view note_resolutions" ON note_resolutions FOR SELECT USING (
  project_id IN (SELECT auth_user_project_ids())
);

-- Coordinators can insert note resolutions
CREATE POLICY "Coordinators insert note_resolutions" ON note_resolutions FOR INSERT WITH CHECK (
  project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
);

-- Coordinators can delete note resolutions (reopen)
CREATE POLICY "Coordinators delete note_resolutions" ON note_resolutions FOR DELETE USING (
  project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
);
