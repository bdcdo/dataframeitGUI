ALTER TABLE documents ADD COLUMN text_hash TEXT;
UPDATE documents SET text_hash = md5(text) WHERE text_hash IS NULL;
CREATE INDEX idx_documents_project_hash ON documents(project_id, text_hash);
CREATE INDEX idx_documents_project_external_id ON documents(project_id, external_id) WHERE external_id IS NOT NULL;
