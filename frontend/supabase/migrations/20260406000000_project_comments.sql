-- Comentários soltos: notas livres linkáveis a documento, campo, ambos, ou nada
CREATE TABLE project_comments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id  UUID REFERENCES documents(id) ON DELETE SET NULL,
  field_name   TEXT,
  author_id    UUID NOT NULL REFERENCES profiles(id),
  body         TEXT NOT NULL,
  parent_id    UUID REFERENCES project_comments(id) ON DELETE CASCADE,
  resolved_at  TIMESTAMPTZ,
  resolved_by  UUID REFERENCES profiles(id),
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_pc_project ON project_comments(project_id);
CREATE INDEX idx_pc_doc ON project_comments(project_id, document_id);

ALTER TABLE project_comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view project comments" ON project_comments
  FOR SELECT USING (
    project_id IN (SELECT project_id FROM project_members WHERE user_id = clerk_uid())
  );

CREATE POLICY "Members can create project comments" ON project_comments
  FOR INSERT WITH CHECK (
    project_id IN (SELECT project_id FROM project_members WHERE user_id = clerk_uid())
  );

CREATE POLICY "Coordinators can update project comments" ON project_comments
  FOR UPDATE USING (
    project_id IN (
      SELECT project_id FROM project_members
      WHERE user_id = clerk_uid() AND role = 'coordenador'
    )
  );

-- Authors can also update their own comments (e.g. edit body)
CREATE POLICY "Authors can update own comments" ON project_comments
  FOR UPDATE USING (
    author_id = clerk_uid()
  );
