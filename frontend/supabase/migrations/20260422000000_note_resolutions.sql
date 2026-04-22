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

CREATE POLICY "Members view note_resolutions" ON note_resolutions
  FOR SELECT USING (
    project_id IN (SELECT project_id FROM project_members WHERE user_id = clerk_uid())
  );

CREATE POLICY "Members insert note_resolutions" ON note_resolutions
  FOR INSERT WITH CHECK (
    project_id IN (SELECT project_id FROM project_members WHERE user_id = clerk_uid())
  );

CREATE POLICY "Members delete note_resolutions" ON note_resolutions
  FOR DELETE USING (
    project_id IN (SELECT project_id FROM project_members WHERE user_id = clerk_uid())
  );
