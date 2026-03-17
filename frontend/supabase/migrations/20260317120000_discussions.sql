-- discussions
CREATE TABLE discussions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id  UUID REFERENCES documents(id) ON DELETE SET NULL,
  created_by   UUID NOT NULL REFERENCES profiles(id),
  title        TEXT NOT NULL,
  body         TEXT,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolved_by  UUID REFERENCES profiles(id),
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_discussions_project ON discussions(project_id);

ALTER TABLE discussions ENABLE ROW LEVEL SECURITY;

-- Any project member can view discussions
CREATE POLICY "Members view discussions" ON discussions FOR SELECT USING (
  project_id IN (SELECT auth_user_project_ids())
);

-- Any project member can create discussions
CREATE POLICY "Members create discussions" ON discussions FOR INSERT WITH CHECK (
  project_id IN (SELECT auth_user_project_ids())
  AND created_by = auth.uid()
);

-- Coordinators can update discussions (resolve/reopen)
CREATE POLICY "Coordinators update discussions" ON discussions FOR UPDATE USING (
  project_id IN (SELECT auth_user_coordinator_project_ids())
);

-- discussion_comments
CREATE TABLE discussion_comments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discussion_id  UUID NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
  created_by     UUID NOT NULL REFERENCES profiles(id),
  body           TEXT NOT NULL,
  created_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_discussion_comments_discussion ON discussion_comments(discussion_id);

ALTER TABLE discussion_comments ENABLE ROW LEVEL SECURITY;

-- Any project member can view comments (join via discussions.project_id)
CREATE POLICY "Members view discussion_comments" ON discussion_comments FOR SELECT USING (
  discussion_id IN (
    SELECT id FROM discussions WHERE project_id IN (SELECT auth_user_project_ids())
  )
);

-- Any project member can create comments
CREATE POLICY "Members create discussion_comments" ON discussion_comments FOR INSERT WITH CHECK (
  discussion_id IN (
    SELECT id FROM discussions WHERE project_id IN (SELECT auth_user_project_ids())
  )
  AND created_by = auth.uid()
);
