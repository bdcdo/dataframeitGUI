-- Safety: a migration 20260513000000 ficou registrada como aplicada no remoto
-- antes do push de hoje, entao seu SQL pode nao ter rodado de fato. Repetimos
-- o ALTER aqui (idempotente: DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT).
--
-- Esta migration e redundante apos o primeiro deploy bem-sucedido. Pode ser
-- removida em uma limpeza futura (>= 2026-06-13) apos confirmar via
-- `supabase migration list` que todos os ambientes aplicaram.

ALTER TABLE assignments DROP CONSTRAINT IF EXISTS assignments_type_check;
ALTER TABLE assignments ADD CONSTRAINT assignments_type_check
  CHECK (type IN ('codificacao', 'comparacao', 'auto_revisao', 'arbitragem'));
