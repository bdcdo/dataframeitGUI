-- Fix chicken-and-egg: allow project creator to insert members.
-- Cria a policy "Creator inserts members" pela primeira vez (a duplicata que
-- existia na 001 foi removida — era o drift que quebrava o boot do zero com
-- SQLSTATE 42710; migrations de RLS posteriores, clerk_uid_rls/master_users,
-- a redefinem). O DROP IF EXISTS antes do CREATE é defensivo/idempotente, no
-- padrão das demais migrations de policy; no remoto não tem efeito (já aplicada).
DROP POLICY IF EXISTS "Creator inserts members" ON project_members;
CREATE POLICY "Creator inserts members" ON project_members FOR INSERT WITH CHECK (
  project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
);
