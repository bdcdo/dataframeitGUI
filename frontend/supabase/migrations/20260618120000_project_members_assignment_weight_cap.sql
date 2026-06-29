-- Peso e limite de carga por membro no sorteio de atribuicoes.
--
-- assignment_weight: proporcao relativa de carga no sorteio (1 = normal,
--   0.5 = recebe metade do que um membro de peso 1). Entra na chave de
--   distribuicao como load/weight (ver distributeDocs em lottery-utils.ts).
-- assignment_cap: teto absoluto de docs novos por sorteio (NULL = sem limite
--   individual; compoe com o limite global docsPerResearcher, vence o menor).
--
-- Editados no LotteryDialog e persistidos aqui ao sortear, para pre-preencher
-- o proximo sorteio com o ultimo valor usado por membro.
ALTER TABLE project_members
  ADD COLUMN assignment_weight NUMERIC NOT NULL DEFAULT 1
    CHECK (assignment_weight > 0),
  ADD COLUMN assignment_cap INTEGER
    CHECK (assignment_cap IS NULL OR assignment_cap > 0);
