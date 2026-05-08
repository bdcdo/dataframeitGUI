-- Vincula cada rodada ao lote (assignment_batches) que a originou.
--
-- Permite backfill idempotente: scripts e a UI podem checar
-- "ja existe rodada com source_batch_id = X?" antes de inserir, sem
-- depender de comparacao por label (que pode ser editado).
--
-- Mantem-se opcional/NULL: rodadas criadas manualmente em /config/rounds
-- nao tem batch de origem.

ALTER TABLE rounds
  ADD COLUMN source_batch_id UUID NULL
    REFERENCES assignment_batches(id) ON DELETE SET NULL;

-- Index unico parcial: cada batch gera no maximo uma rodada, mas multiplas
-- rodadas podem ter source_batch_id = NULL (rodadas manuais).
CREATE UNIQUE INDEX idx_rounds_source_batch
  ON rounds(source_batch_id)
  WHERE source_batch_id IS NOT NULL;
