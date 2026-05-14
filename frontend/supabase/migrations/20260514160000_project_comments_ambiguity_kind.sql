-- Veredito "ambiguo" na aba Comparar vira comentario automatico.
--
-- Quando um revisor marca um campo como ambiguo, o submitVerdict cria um
-- project_comments com kind='ambiguity' vinculado a documento + campo, para
-- que a ambiguidade apareca na aba Comentarios sem passo manual.
--
-- O indice unico parcial garante idempotencia: um unico comentario de
-- ambiguidade por (projeto, documento, campo), independente de quantas vezes
-- ou por quantos revisores o campo seja remarcado.

ALTER TABLE project_comments
  DROP CONSTRAINT project_comments_kind_check;

ALTER TABLE project_comments
  ADD CONSTRAINT project_comments_kind_check
    CHECK (kind IN ('note', 'exclusion_request', 'ambiguity'));

CREATE UNIQUE INDEX idx_pc_ambiguity_unique
  ON project_comments(project_id, document_id, field_name)
  WHERE kind = 'ambiguity';
