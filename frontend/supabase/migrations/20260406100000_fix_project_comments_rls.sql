-- Fix RLS policies for project_comments

-- 1. INSERT: enforce author_id = clerk_uid()
DROP POLICY "Members can create project comments" ON project_comments;
CREATE POLICY "Members can create project comments" ON project_comments
  FOR INSERT WITH CHECK (
    author_id = clerk_uid()
    AND project_id IN (SELECT project_id FROM project_members WHERE user_id = clerk_uid())
  );

-- 2. Coordinators UPDATE: add WITH CHECK
DROP POLICY "Coordinators can update project comments" ON project_comments;
CREATE POLICY "Coordinators can update project comments" ON project_comments
  FOR UPDATE
  USING (
    project_id IN (
      SELECT project_id FROM project_members
      WHERE user_id = clerk_uid() AND role = 'coordenador'
    )
  )
  WITH CHECK (
    project_id IN (
      SELECT project_id FROM project_members
      WHERE user_id = clerk_uid() AND role = 'coordenador'
    )
  );

-- 3. Authors UPDATE: add WITH CHECK
DROP POLICY "Authors can update own comments" ON project_comments;
CREATE POLICY "Authors can update own comments" ON project_comments
  FOR UPDATE
  USING (author_id = clerk_uid())
  WITH CHECK (author_id = clerk_uid());

-- 4. Add missing index on author_id
CREATE INDEX idx_pc_author ON project_comments(author_id);
