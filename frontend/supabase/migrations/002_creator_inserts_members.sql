-- Fix chicken-and-egg: allow project creator to insert members.
-- Idempotente: a policy também é criada em 001_initial_schema.sql (a 001 foi
-- editada depois para incluí-la), então em banco fresh (supabase start / db
-- reset) esta migration colidiria com SQLSTATE 42710. O DROP IF EXISTS antes do
-- CREATE segue o padrão das demais migrations de policy e mantém o boot do zero
-- funcionando, sem efeito no remoto (já aplicada incrementalmente).
DROP POLICY IF EXISTS "Creator inserts members" ON project_members;
CREATE POLICY "Creator inserts members" ON project_members FOR INSERT WITH CHECK (
  project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
);
