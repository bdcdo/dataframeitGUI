-- project_members.can_compare: flag por membro controlando se ele entra no
-- sorteio de revisores de comparação em assignComparisonReviewer()
-- (lib/auto-comparison.ts), análogo a can_arbitrate para a arbitragem.
--
-- Default false e SEM backfill (diferente de can_arbitrate): a comparação
-- automática é feature nova e opt-in — nenhum projeto dependia desse
-- comportamento antes. O coordenador marca explicitamente quem revisa.

ALTER TABLE project_members
  ADD COLUMN can_compare BOOLEAN NOT NULL DEFAULT false;

-- Index parcial: assignComparisonReviewer() filtra por (project_id, can_compare=true).
CREATE INDEX idx_project_members_comparers
  ON project_members (project_id)
  WHERE can_compare = true;
