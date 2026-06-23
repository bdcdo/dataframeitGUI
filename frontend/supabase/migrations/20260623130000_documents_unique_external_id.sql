-- Impede recorrencia das duplicatas de documentos por re-importacao.
--
-- Causa raiz (ver docs/DEDUP_ZOLGENSMA_2026-06.md): documents nao tinha
-- UNIQUE(project_id, external_id), e uploadDocuments (modo default add_all)
-- faz INSERT puro -> cada re-import recriava os documentos, espalhando
-- responses/reviews entre copias e quebrando as comparacoes automaticas.
--
-- Indice UNICO PARCIAL: no maximo UMA copia ATIVA por (project_id, external_id).
-- Compativel com o soft-delete (excluded_at): permite uma copia excluida + uma
-- ativa, mas bloqueia duas ativas com o mesmo external_id. NULLs em external_id
-- ficam de fora (varios docs sem external_id sao validos).
--
-- Pre-requisito ja satisfeito: as duplicatas ativas pre-existentes dos projetos
-- Zolgensma (0c6394da) e Zolgensma-Judiciario (00779233) foram resolvidas por
-- dedup antes desta migration, entao a criacao do indice nao viola.

CREATE UNIQUE INDEX IF NOT EXISTS documents_project_external_id_active_uniq
  ON documents (project_id, external_id)
  WHERE external_id IS NOT NULL AND excluded_at IS NULL;
