-- Soft delete de documentos.
--
-- Antes: deleteDocuments fazia DELETE FROM documents (CASCADE removia
-- responses/reviews/assignments). Sem reversibilidade nem auditoria.
--
-- Agora: documents.excluded_at marca exclusao logica. Reads filtram
-- excluded_at IS NULL por padrao. Coordenador pode visualizar excluidos via
-- toggle e restaurar, ou apagar permanentemente quando confirmado.

ALTER TABLE documents
  ADD COLUMN excluded_at TIMESTAMPTZ NULL,
  ADD COLUMN excluded_reason TEXT NULL,
  ADD COLUMN excluded_by UUID NULL REFERENCES profiles(id);

-- Index parcial: queries default (excluded_at IS NULL) sao maioria;
-- excluidos sao raros e so coordenador acessa.
CREATE INDEX idx_documents_active
  ON documents(project_id)
  WHERE excluded_at IS NULL;
