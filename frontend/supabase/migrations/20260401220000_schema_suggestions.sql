-- Sugestões de alteração no schema por pesquisadores
CREATE TABLE schema_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  suggested_by UUID NOT NULL REFERENCES profiles(id),
  suggested_changes JSONB NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  resolved_by UUID REFERENCES profiles(id),
  resolved_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_schema_suggestions_project ON schema_suggestions(project_id);

-- RLS: membros podem ver, pesquisadores podem criar, coordenadores podem resolver
ALTER TABLE schema_suggestions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view suggestions" ON schema_suggestions
  FOR SELECT USING (
    project_id IN (SELECT project_id FROM project_members WHERE user_id = clerk_uid())
  );

CREATE POLICY "Members can create suggestions" ON schema_suggestions
  FOR INSERT WITH CHECK (
    project_id IN (SELECT project_id FROM project_members WHERE user_id = clerk_uid())
  );

CREATE POLICY "Coordinators can update suggestions" ON schema_suggestions
  FOR UPDATE USING (
    project_id IN (
      SELECT project_id FROM project_members
      WHERE user_id = clerk_uid() AND role = 'coordenador'
    )
  );
