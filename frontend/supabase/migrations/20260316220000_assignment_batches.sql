-- Tabela de lotes de sorteio
CREATE TABLE assignment_batches (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            UUID REFERENCES projects(id) ON DELETE CASCADE,
  created_by            UUID REFERENCES profiles(id),
  created_at            TIMESTAMPTZ DEFAULT now(),
  -- Parâmetros do sorteio
  researchers_per_doc   INTEGER NOT NULL DEFAULT 2,
  docs_per_researcher   INTEGER,
  doc_subset_size       INTEGER,
  -- Prazo
  deadline_mode         TEXT CHECK (deadline_mode IN ('none', 'batch', 'recurring')) DEFAULT 'none',
  deadline_date         DATE,
  recurring_count       INTEGER,
  recurring_start       DATE,
  label                 TEXT
);

-- RLS
ALTER TABLE assignment_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members view batches" ON assignment_batches FOR SELECT USING (
  project_id IN (SELECT project_id FROM project_members WHERE user_id = auth.uid())
  OR project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
);

CREATE POLICY "Coordinators manage batches" ON assignment_batches FOR ALL USING (
  project_id IN (
    SELECT project_id FROM project_members WHERE user_id = auth.uid() AND role = 'coordenador'
  )
  OR project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
);

-- Novos campos em assignments
ALTER TABLE assignments
  ADD COLUMN batch_id     UUID REFERENCES assignment_batches(id) ON DELETE SET NULL,
  ADD COLUMN deadline     DATE,
  ADD COLUMN completed_at TIMESTAMPTZ;
