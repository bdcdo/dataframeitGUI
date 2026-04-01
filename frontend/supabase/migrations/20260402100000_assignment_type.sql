-- Adicionar coluna type para distinguir codificação e comparação
ALTER TABLE assignments
  ADD COLUMN type TEXT NOT NULL DEFAULT 'codificacao'
  CHECK (type IN ('codificacao', 'comparacao'));

-- Substituir constraint UNIQUE para incluir type
ALTER TABLE assignments DROP CONSTRAINT assignments_document_id_user_id_key;
ALTER TABLE assignments ADD CONSTRAINT assignments_document_id_user_id_type_key
  UNIQUE(document_id, user_id, type);

-- Index para queries filtradas por type
CREATE INDEX idx_assignments_type ON assignments(project_id, type);
