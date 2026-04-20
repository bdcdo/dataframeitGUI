-- Versionamento semver do schema Pydantic do projeto.
-- MINOR/PATCH bumpados automaticamente no save; MAJOR é gesto manual do coordenador.
-- Respostas carregam a versão em que foram gravadas. Nada é invalidado.

ALTER TABLE projects
  ADD COLUMN schema_version_major INT NOT NULL DEFAULT 0,
  ADD COLUMN schema_version_minor INT NOT NULL DEFAULT 1,
  ADD COLUMN schema_version_patch INT NOT NULL DEFAULT 0;

ALTER TABLE responses
  ADD COLUMN schema_version_major INT,
  ADD COLUMN schema_version_minor INT,
  ADD COLUMN schema_version_patch INT;

CREATE INDEX idx_responses_schema_version
  ON responses(project_id, schema_version_major, schema_version_minor, schema_version_patch);

-- Backfill: tudo que existe hoje passa a ser 0.1.0
UPDATE responses
  SET schema_version_major = 0,
      schema_version_minor = 1,
      schema_version_patch = 0
  WHERE schema_version_major IS NULL;

ALTER TABLE schema_change_log
  ADD COLUMN change_type TEXT CHECK (change_type IN ('major','minor','patch','initial')),
  ADD COLUMN version_major INT,
  ADD COLUMN version_minor INT,
  ADD COLUMN version_patch INT;
