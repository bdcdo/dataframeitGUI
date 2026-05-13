-- Refina a policy SELECT de field_reviews para amarrar project_id nos braços
-- self_reviewer_id e arbitrator_id.
--
-- A versão anterior (em 020000) permitia que `self_reviewer_id = clerk_uid()`
-- ou `arbitrator_id = clerk_uid()` retornassem linhas SEM verificar se o
-- usuário ainda tem acesso ao projeto. Resultado: um pesquisador removido de
-- um projeto (ou nunca incluído nele) que aparecesse historicamente como
-- self_reviewer/arbitrator continuaria lendo essas linhas.
--
-- Esta migration substitui a policy combinando os dois braços com
-- AND project_id IN (auth_user_accessible_project_ids()).

DROP POLICY IF EXISTS "Members view own field_reviews" ON field_reviews;

CREATE POLICY "Members view own field_reviews" ON field_reviews FOR SELECT USING (
  is_master()
  OR project_id IN (SELECT auth_user_coordinator_or_creator_project_ids())
  OR (
    project_id IN (SELECT auth_user_accessible_project_ids())
    AND (self_reviewer_id = clerk_uid() OR arbitrator_id = clerk_uid())
  )
);
