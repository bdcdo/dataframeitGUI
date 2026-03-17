-- Pesquisadores podem atualizar status e completed_at dos seus proprios assignments.
-- Escopo restrito: so UPDATE (nao INSERT/DELETE), apenas rows onde user_id = auth.uid().
CREATE POLICY "Researchers update own assignments"
  ON assignments FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
