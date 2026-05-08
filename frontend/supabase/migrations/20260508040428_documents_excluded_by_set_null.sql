-- Ajusta FK documents.excluded_by para ON DELETE SET NULL.
--
-- Migration original (#95) criou a FK sem ON DELETE, default NO ACTION.
-- Se um perfil for hard-deletado (master removendo usuario), a FK quebra
-- e impede o DELETE. SET NULL preserva o registro de exclusao do documento
-- mesmo quando o autor sai do sistema.

ALTER TABLE documents
  DROP CONSTRAINT IF EXISTS documents_excluded_by_fkey;

ALTER TABLE documents
  ADD CONSTRAINT documents_excluded_by_fkey
  FOREIGN KEY (excluded_by) REFERENCES profiles(id) ON DELETE SET NULL;
