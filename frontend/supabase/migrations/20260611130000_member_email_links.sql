-- Vínculo de múltiplos e-mails por membro (spec 002, US2).
--
-- member_email_links registra e-mails adicionais vinculados a um membro, com
-- efeito restrito ao projeto (FR-013). Serve também de alias: quando a conta
-- dona do e-mail existe (linked_user_id preenchido), ela acessa o projeto como
-- member_user_id — via (a) RLS estendida abaixo e (b) getEffectiveMemberId na
-- aplicação. Ver data-model.md da spec 002.

-- ========== 1. Tabela ==========
CREATE TABLE member_email_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- identidade canônica no projeto
  member_user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  -- sempre lowercase (normalizado na server action)
  email TEXT NOT NULL,
  -- conta que usa o e-mail; NULL até a conta existir (resolvido no webhook)
  linked_user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_by UUID NOT NULL REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- FR-011: 1 e-mail → 1 membro por projeto
  UNIQUE (project_id, email)
);

CREATE INDEX idx_member_email_links_project ON member_email_links(project_id);
-- usado pelas funções RLS
CREATE INDEX idx_member_email_links_linked_user ON member_email_links(linked_user_id);
-- lookup no webhook de signup
CREATE INDEX idx_member_email_links_email ON member_email_links(email);

-- ========== 2. RLS da tabela ==========
ALTER TABLE member_email_links ENABLE ROW LEVEL SECURITY;

-- FR-015: e-mails vinculados visíveis a todos os membros do projeto
CREATE POLICY "Members view member_email_links" ON member_email_links FOR SELECT USING (
  project_id IN (SELECT auth_user_accessible_project_ids())
  OR is_master()
);
-- FR-014: mutação só por coordenadores/criador (na prática via admin client
-- nas actions, como project_members hoje)
CREATE POLICY "Coordinators manage member_email_links" ON member_email_links FOR ALL USING (
  project_id IN (SELECT auth_user_coordinator_or_creator_project_ids())
  OR is_master()
);

-- ========== 3. Funções de acesso ==========
-- Estende a função unificada de 20260512000000: contas vinculadas acessam o
-- projeto do vínculo (e apenas ele — FR-013).
CREATE OR REPLACE FUNCTION auth_user_accessible_project_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT project_id FROM public.project_members WHERE user_id = public.clerk_uid()
  UNION
  SELECT id FROM public.projects WHERE created_by = public.clerk_uid()
  UNION
  SELECT project_id FROM public.member_email_links WHERE linked_user_id = public.clerk_uid()
$$;

-- Identidades que o usuário atual pode exercer num projeto: a própria +
-- canônicas via alias. Usada pelas policies de "own rows" abaixo.
CREATE OR REPLACE FUNCTION auth_user_member_identity_ids(p_project_id UUID)
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT public.clerk_uid()
  UNION
  SELECT member_user_id FROM public.member_email_links
   WHERE project_id = p_project_id AND linked_user_id = public.clerk_uid()
$$;

GRANT EXECUTE ON FUNCTION auth_user_member_identity_ids(UUID) TO anon, authenticated, service_role;

-- ========== 4. responses — own rows aceitam o id canônico via alias ==========
-- Texto anterior em 20260512000000_rls_unified_project_access.sql.
DROP POLICY IF EXISTS "Users manage own responses" ON responses;
CREATE POLICY "Users manage own responses" ON responses FOR ALL USING (
  respondent_id IN (SELECT auth_user_member_identity_ids(project_id))
  OR project_id IN (SELECT auth_user_coordinator_or_creator_project_ids())
  OR is_master()
);

-- ========== 5. reviews ==========
-- Texto anterior em 20260512000000_rls_unified_project_access.sql.
DROP POLICY IF EXISTS "Reviewers manage reviews" ON reviews;
CREATE POLICY "Reviewers manage reviews" ON reviews FOR ALL USING (
  reviewer_id IN (SELECT auth_user_member_identity_ids(project_id))
  OR project_id IN (SELECT auth_user_coordinator_or_creator_project_ids())
  OR is_master()
);

-- ========== 6. field_reviews ==========
-- SELECT: texto anterior em 20260513050000_field_reviews_rls_project_scoped.sql
-- (braços own amarrados a project_id acessível — preservado).
DROP POLICY IF EXISTS "Members view own field_reviews" ON field_reviews;
CREATE POLICY "Members view own field_reviews" ON field_reviews FOR SELECT USING (
  is_master()
  OR project_id IN (SELECT auth_user_coordinator_or_creator_project_ids())
  OR (
    project_id IN (SELECT auth_user_accessible_project_ids())
    AND (
      self_reviewer_id IN (SELECT auth_user_member_identity_ids(project_id))
      OR arbitrator_id IN (SELECT auth_user_member_identity_ids(project_id))
    )
  )
);

-- INSERT/UPDATE: texto anterior em 20260513020000_field_reviews_rls_tighten.sql.
DROP POLICY IF EXISTS "Self reviewer inserts own row" ON field_reviews;
CREATE POLICY "Self reviewer inserts own row" ON field_reviews FOR INSERT
  WITH CHECK (self_reviewer_id IN (SELECT auth_user_member_identity_ids(project_id)));

DROP POLICY IF EXISTS "Self reviewer updates own row" ON field_reviews;
CREATE POLICY "Self reviewer updates own row" ON field_reviews FOR UPDATE
  USING (self_reviewer_id IN (SELECT auth_user_member_identity_ids(project_id)))
  WITH CHECK (self_reviewer_id IN (SELECT auth_user_member_identity_ids(project_id)));

DROP POLICY IF EXISTS "Arbitrator updates own row" ON field_reviews;
CREATE POLICY "Arbitrator updates own row" ON field_reviews FOR UPDATE
  USING (arbitrator_id IN (SELECT auth_user_member_identity_ids(project_id)))
  WITH CHECK (arbitrator_id IN (SELECT auth_user_member_identity_ids(project_id)));
