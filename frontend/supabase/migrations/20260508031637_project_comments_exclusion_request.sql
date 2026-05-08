-- Sugestao de exclusao de documentos pelo pesquisador.
--
-- Reusa project_comments adicionando kind='exclusion_request'. Pesquisador
-- cria comentario nesse tipo a partir da view de codificacao quando suspeita
-- que o documento e fora de escopo. Coordenador, em /reviews/comments, ve a
-- sugestao e pode aprovar (faz soft delete em documents) ou rejeitar.

ALTER TABLE project_comments
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'note'
    CHECK (kind IN ('note', 'exclusion_request')),
  ADD COLUMN rejected_at TIMESTAMPTZ NULL,
  ADD COLUMN rejected_reason TEXT NULL;

CREATE INDEX idx_pc_pending_exclusions
  ON project_comments(project_id)
  WHERE kind = 'exclusion_request'
    AND resolved_at IS NULL
    AND rejected_at IS NULL;
