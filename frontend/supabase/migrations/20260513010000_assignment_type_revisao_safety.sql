-- Safety/historico: este arquivo foi criado quando a migration 20260513000000_assignment_type_revisao.sql
-- foi pulada pelo supabase no remoto (colisao de versao com 20260513000000_researcher_field_orders.sql
-- do PR #110). O arquivo original foi renomeado para 20260513005000 (com SQL idempotente) — entao,
-- em ambientes novos, este safety vira no-op pois a constraint ja vai estar definida.
--
-- Mantido no historico (em vez de deletado) porque ja foi aplicado nos ambientes existentes; remover
-- agora geraria warning de "applied migration not found locally" em todo `supabase db pull/push`.
-- Pode ser deletado em uma limpeza futura (>= 2026-07-13) junto com `migration repair --status reverted`.

ALTER TABLE assignments DROP CONSTRAINT IF EXISTS assignments_type_check;
ALTER TABLE assignments ADD CONSTRAINT assignments_type_check
  CHECK (type IN ('codificacao', 'comparacao', 'auto_revisao', 'arbitragem'));
