-- Estende o CHECK de assignments.type com 'auto_revisao' e 'arbitragem'.
-- A constraint UNIQUE (document_id, user_id, type) ja tolera multiplos types
-- por (doc, user) — preservada como esta.

ALTER TABLE assignments DROP CONSTRAINT IF EXISTS assignments_type_check;
ALTER TABLE assignments ADD CONSTRAINT assignments_type_check
  CHECK (type IN ('codificacao', 'comparacao', 'auto_revisao', 'arbitragem'));
