-- Add resolve/reopen support to reviews (comparison comments)
ALTER TABLE reviews
  ADD COLUMN resolved_at TIMESTAMPTZ,
  ADD COLUMN resolved_by UUID REFERENCES profiles(id);

-- Table for resolving LLM difficulty reports
-- (llm_ambiguidades lives in responses.answers, has no entity of its own)
CREATE TABLE difficulty_resolutions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  response_id  UUID NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  document_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  resolved_by  UUID NOT NULL REFERENCES profiles(id),
  resolved_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  note         TEXT,
  discussion_id UUID REFERENCES discussions(id),
  UNIQUE(project_id, response_id)
);

CREATE INDEX idx_difficulty_resolutions_project ON difficulty_resolutions(project_id);

ALTER TABLE difficulty_resolutions ENABLE ROW LEVEL SECURITY;

-- Any project member can view difficulty resolutions
CREATE POLICY "Members view difficulty_resolutions" ON difficulty_resolutions FOR SELECT USING (
  project_id IN (SELECT auth_user_project_ids())
);

-- Coordinators can insert difficulty resolutions
CREATE POLICY "Coordinators insert difficulty_resolutions" ON difficulty_resolutions FOR INSERT WITH CHECK (
  project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
);

-- Coordinators can delete difficulty resolutions (reopen)
CREATE POLICY "Coordinators delete difficulty_resolutions" ON difficulty_resolutions FOR DELETE USING (
  project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
);
