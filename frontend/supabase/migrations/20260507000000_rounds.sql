-- Rodadas de codificacao.
--
-- Coordenadores podem optar entre duas estrategias:
--   1) schema_version (default): rodada = versao atual do schema do projeto.
--      Reaproveita schema_version_major/minor/patch ja gravado em responses.
--   2) manual: rodada = entidade explicita (tabela rounds). Coordenador cria
--      rodadas e marca uma como atual via projects.current_round_id.
--
-- Quando estrategia=manual, saveResponse grava round_id = current_round_id
-- no momento do save. Re-codificar uma resposta antiga "promove" para a
-- rodada atual (sobrescrevendo round_id), seguindo o mesmo modelo de update
-- in-place que ja existe para schema_version.

ALTER TABLE projects
  ADD COLUMN round_strategy TEXT NOT NULL DEFAULT 'schema_version'
    CHECK (round_strategy IN ('schema_version', 'manual')),
  ADD COLUMN current_round_id UUID NULL;

CREATE TABLE rounds (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, label)
);

CREATE INDEX idx_rounds_project ON rounds(project_id, created_at DESC);

ALTER TABLE projects
  ADD CONSTRAINT projects_current_round_fk
  FOREIGN KEY (current_round_id) REFERENCES rounds(id) ON DELETE SET NULL;

ALTER TABLE responses
  ADD COLUMN round_id UUID NULL REFERENCES rounds(id) ON DELETE SET NULL;

CREATE INDEX idx_responses_round ON responses(project_id, round_id);

ALTER TABLE rounds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members view rounds" ON rounds FOR SELECT USING (
  project_id IN (SELECT auth_user_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
);

CREATE POLICY "Coordinators manage rounds" ON rounds FOR ALL USING (
  project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
)
WITH CHECK (
  project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
);
