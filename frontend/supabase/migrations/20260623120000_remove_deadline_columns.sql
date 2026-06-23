-- Remove a infraestrutura de controle de prazo (issue #176).
-- Descarta os prazos históricos: a plataforma deixou de gerenciar deadline.
-- A CHECK constraint de deadline_mode cai junto com a coluna; não há índices nem FKs sobre estes campos.
ALTER TABLE assignments DROP COLUMN IF EXISTS deadline;

ALTER TABLE assignment_batches
  DROP COLUMN IF EXISTS deadline_mode,
  DROP COLUMN IF EXISTS deadline_date,
  DROP COLUMN IF EXISTS recurring_count,
  DROP COLUMN IF EXISTS recurring_start;
