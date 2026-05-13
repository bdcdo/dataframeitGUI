-- Safety: a migration 20260513000000 ficou registrada como aplicada no remoto
-- antes do push de hoje, entao seu SQL pode nao ter rodado de fato. Repetimos
-- o ALTER aqui (idempotente: DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT).

ALTER TABLE assignments DROP CONSTRAINT IF EXISTS assignments_type_check;
ALTER TABLE assignments ADD CONSTRAINT assignments_type_check
  CHECK (type IN ('codificacao', 'comparacao', 'auto_revisao', 'arbitragem'));
