-- project_members.can_arbitrate: flag por membro controlando se ele entra no
-- sorteio de árbitros em assignArbitrator() (actions/field-reviews.ts).
--
-- Default false: novos membros entram NÃO elegíveis para arbitrar; o
-- coordenador habilita explicitamente quem deve receber casos. Decisão de
-- design para evitar a sobrecarga atual em que todo membro do projeto era
-- candidato automaticamente.
--
-- Backfill true: preserva o comportamento atual em projetos já em produção
-- — todo mundo continua elegível até o coordenador desmarcar. Sem esse
-- backfill, casos pendentes de arbitragem nos projetos existentes ficariam
-- sem árbitro elegível assim que a migration aplicasse.

ALTER TABLE project_members
  ADD COLUMN can_arbitrate BOOLEAN NOT NULL DEFAULT false;

UPDATE project_members SET can_arbitrate = true;

-- Index parcial: assignArbitrator() filtra por (project_id, can_arbitrate=true).
-- Em projetos com muitos membros e muitos desabilitados, o index parcial é mais
-- compacto e mantém o lookup rápido.
CREATE INDEX idx_project_members_arbiters
  ON project_members (project_id)
  WHERE can_arbitrate = true;
