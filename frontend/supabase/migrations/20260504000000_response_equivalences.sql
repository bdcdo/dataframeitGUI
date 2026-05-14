-- NOTE: no registro de migrations do Supabase remoto, a versao 20260504000000
-- aparece com o nome "schema_change_log_composite_index" (mesmo nome da
-- 20260504000001), e nao "response_equivalences". E so o campo `name` do
-- registro; o `db push` casa por versao, entao nao ha risco de reaplicacao.
-- Divergencia cosmetica conhecida — ver PR #139.

-- Response equivalence groups (per-field, project-shared).
-- Lets reviewers mark two free-text responses as equivalent so the
-- comparison view fuses them into a single answer card and divergence
-- detection treats them as the same.
--
-- Pairs are stored canonically (response_a_id < response_b_id) and
-- transitive closure is computed in app code via union-find.

CREATE TABLE response_equivalences (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  field_name      TEXT NOT NULL,
  response_a_id   UUID NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  response_b_id   UUID NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  reviewer_id     UUID REFERENCES profiles(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (response_a_id < response_b_id),
  UNIQUE (project_id, document_id, field_name, response_a_id, response_b_id)
);

CREATE INDEX idx_response_equiv_doc_field
  ON response_equivalences(project_id, document_id, field_name);
CREATE INDEX idx_response_equiv_project
  ON response_equivalences(project_id);

ALTER TABLE response_equivalences ENABLE ROW LEVEL SECURITY;

-- Any project member (or master) can view equivalences (shared scope).
CREATE POLICY "Members view response_equivalences" ON response_equivalences
FOR SELECT USING (
  project_id IN (SELECT auth_user_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
  OR is_master()
);

-- The reviewer who created the row, coordinators, project creator, or master can manage.
CREATE POLICY "Reviewers manage response_equivalences" ON response_equivalences
FOR ALL USING (
  reviewer_id = clerk_uid()
  OR project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
  OR is_master()
);
