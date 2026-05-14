-- Veredito "ambiguo" na aba Comparar vira comentario automatico.
--
-- Quando um revisor marca um campo como ambiguo, o submitVerdict cria um
-- project_comments com kind='ambiguity' vinculado a documento + campo, para
-- que a ambiguidade apareca na aba Comentarios sem passo manual. Quando o
-- campo deixa de ser ambiguo (e nenhum outro revisor ainda o marca assim), o
-- submitVerdict remove o comentario.
--
-- O indice unico parcial garante idempotencia: um unico comentario de
-- ambiguidade por (projeto, documento, campo), independente de quantas vezes
-- ou por quantos revisores o campo seja remarcado.
--
-- A migration em si tambem e idempotente (DROP ... IF EXISTS, CREATE INDEX
-- IF NOT EXISTS, DROP POLICY antes de CREATE) para sobreviver a uma
-- reaplicacao via `supabase db push`.

ALTER TABLE project_comments
  DROP CONSTRAINT IF EXISTS project_comments_kind_check;

ALTER TABLE project_comments
  ADD CONSTRAINT project_comments_kind_check
    CHECK (kind IN ('note', 'exclusion_request', 'ambiguity'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_pc_ambiguity_unique
  ON project_comments(project_id, document_id, field_name)
  WHERE kind = 'ambiguity';

-- Comentarios de ambiguidade sao gerados automaticamente e espelham o estado
-- do veredito. O revisor que muda o veredito de volta nem sempre e o autor do
-- comentario nem coordenador, entao as policies de UPDATE existentes nao
-- cobrem a remocao. Esta policy de DELETE e escopada a kind='ambiguity' para
-- permitir o cleanup automatico sem expor notas ou sugestoes de exclusao.
DROP POLICY IF EXISTS "Members can delete ambiguity comments" ON project_comments;
CREATE POLICY "Members can delete ambiguity comments" ON project_comments
  FOR DELETE USING (
    kind = 'ambiguity'
    AND project_id IN (
      SELECT project_id FROM project_members WHERE user_id = clerk_uid()
    )
  );
