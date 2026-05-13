-- Refina RLS de field_reviews:
--
--  1) SELECT amplo "Members view" expunha as colunas blind_verdict/final_verdict
--     a TODOS os membros do projeto, inclusive ao humano original durante a
--     fase cega da arbitragem. Embora a UI nao mostre, RLS deve refletir o
--     dominio: cada pesquisador so enxerga suas proprias linhas; coordenadores
--     e criadores continuam vendo tudo (export, dashboards, supervisao).
--
--  2) Policies "Self reviewer manages own row" e "Arbitrator manages own row"
--     eram FOR ALL — concediam INSERT/UPDATE/DELETE/SELECT genericamente.
--     Separamos por verbo para o intent ficar explicito e podermos restringir
--     SELECT no futuro sem confusao com permissoes de escrita.

-- ========== SELECT ==========
DROP POLICY IF EXISTS "Members view field_reviews" ON field_reviews;
CREATE POLICY "Members view own field_reviews" ON field_reviews FOR SELECT USING (
  is_master()
  OR project_id IN (SELECT auth_user_coordinator_or_creator_project_ids())
  OR self_reviewer_id = clerk_uid()
  OR arbitrator_id = clerk_uid()
);

-- ========== Self reviewer ==========
DROP POLICY IF EXISTS "Self reviewer manages own row" ON field_reviews;

CREATE POLICY "Self reviewer inserts own row" ON field_reviews FOR INSERT
  WITH CHECK (self_reviewer_id = clerk_uid());

CREATE POLICY "Self reviewer updates own row" ON field_reviews FOR UPDATE
  USING (self_reviewer_id = clerk_uid())
  WITH CHECK (self_reviewer_id = clerk_uid());

-- ========== Arbitro ==========
DROP POLICY IF EXISTS "Arbitrator manages own row" ON field_reviews;

CREATE POLICY "Arbitrator updates own row" ON field_reviews FOR UPDATE
  USING (arbitrator_id = clerk_uid())
  WITH CHECK (arbitrator_id = clerk_uid());

-- Nota: Coordinators manage field_reviews (FOR ALL) ja cobre INSERT/DELETE
-- de admin/coordenador (preservada).
