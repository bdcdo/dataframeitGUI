-- Estende o CHECK de assignments.type com 'auto_revisao' e 'arbitragem'.
-- A constraint UNIQUE (document_id, user_id, type) ja tolera multiplos types
-- por (doc, user) — preservada como esta.
--
-- Historico: este arquivo foi originalmente nomeado 20260513000000_assignment_type_revisao.sql
-- e colidiu com 20260513000000_researcher_field_orders.sql do PR #110 (mesmo prefixo
-- versiona unica em supabase_migrations.schema_migrations). Renomeado para 20260513005000
-- para garantir aplicacao em ambientes novos. SQL idempotente (DROP IF EXISTS + ADD), entao
-- re-rodar em ambientes onde a safety 20260513010000 ja aplicou e no-op.

ALTER TABLE assignments DROP CONSTRAINT IF EXISTS assignments_type_check;
ALTER TABLE assignments ADD CONSTRAINT assignments_type_check
  CHECK (type IN ('codificacao', 'comparacao', 'auto_revisao', 'arbitragem'));
