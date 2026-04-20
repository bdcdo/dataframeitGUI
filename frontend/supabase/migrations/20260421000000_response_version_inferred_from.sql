-- Rastreia como a versão de cada resposta foi inferida.
-- 'live_save': gravada diretamente em saveResponse (precisão total).
-- 'hashes':    inferida por match de answer_field_hashes contra snapshots reconstruídos.
-- 'created_at': inferida por timestamp de criação (resposta sem answer_field_hashes).
-- 'fallback_created_at': tentou hashes, não bateu, caiu pra timestamp.

ALTER TABLE responses
  ADD COLUMN version_inferred_from TEXT
  CHECK (version_inferred_from IN ('live_save', 'hashes', 'created_at', 'fallback_created_at'));

-- Backfill preliminar: respostas existentes ficam como 'created_at' até o backfill rodar.
UPDATE responses
  SET version_inferred_from = 'created_at'
  WHERE version_inferred_from IS NULL;
