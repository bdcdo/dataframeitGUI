-- Identidade canônica de projeto: uma conta vinculada herda acesso, papel e
-- can_resolve exclusivamente do membro-alvo em cada projeto. A conta bruta
-- continua sendo a fonte de autoria global e de ownership em projects.

-- ========== 1. Invariantes de member_email_links ==========
-- A migration aborta diante de dados malformados. Não há escolha automática
-- de um alias "vencedor" nem remoção silenciosa de vínculos.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.member_email_links mel
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.project_members pm
      WHERE pm.project_id = mel.project_id
        AND pm.user_id = mel.member_user_id
    )
  ) THEN
    RAISE EXCEPTION
      'member_email_links contém membro canônico fora de project_members'
      USING ERRCODE = '23503';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.member_email_links
    WHERE linked_user_id = member_user_id
  ) THEN
    RAISE EXCEPTION
      'member_email_links contém vínculo da conta para ela própria'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.member_email_links
    WHERE linked_user_id IS NOT NULL
    GROUP BY linked_user_id, project_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'member_email_links contém mais de uma identidade canônica para a mesma conta no projeto'
      USING ERRCODE = '23505';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.member_email_links alias_link
    JOIN public.member_email_links canonical_link
      ON canonical_link.project_id = alias_link.project_id
     AND canonical_link.member_user_id = alias_link.linked_user_id
    WHERE alias_link.linked_user_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'member_email_links contém identidade intermediária em uma cadeia de aliases'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER TABLE public.member_email_links
  DROP CONSTRAINT IF EXISTS member_email_links_member_user_id_fkey,
  ADD CONSTRAINT member_email_links_distinct_alias_check
  CHECK (linked_user_id IS NULL OR linked_user_id <> member_user_id),
  ADD CONSTRAINT member_email_links_project_member_fkey
  FOREIGN KEY (project_id, member_user_id)
  REFERENCES public.project_members(project_id, user_id)
  ON DELETE CASCADE;

-- linked_user_id é o primeiro campo porque todas as resoluções partem da
-- conta autenticada. O índice único substitui o índice simples anterior.
CREATE UNIQUE INDEX member_email_links_linked_user_project_key
  ON public.member_email_links (linked_user_id, project_id)
  WHERE linked_user_id IS NOT NULL;

DROP INDEX public.idx_member_email_links_linked_user;

-- Uma identidade é terminal dentro do projeto: ela pode ser conta vinculada
-- ou identidade canônica, nunca as duas coisas. O lock transacional fecha a
-- janela entre a leitura e a escrita de duas transações concorrentes. A
-- serialização é por projeto; aliases distintos ainda podem compartilhar o
-- mesmo target canônico.
CREATE OR REPLACE FUNCTION public.enforce_terminal_member_email_alias()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_new_project_lock BIGINT;
  v_old_project_lock BIGINT;
BEGIN
  v_new_project_lock := pg_catalog.hashtextextended(NEW.project_id::TEXT, 0);

  IF TG_OP = 'UPDATE' AND OLD.project_id IS DISTINCT FROM NEW.project_id THEN
    v_old_project_lock := pg_catalog.hashtextextended(OLD.project_id::TEXT, 0);
    IF v_old_project_lock < v_new_project_lock THEN
      PERFORM pg_catalog.pg_advisory_xact_lock(v_old_project_lock);
      PERFORM pg_catalog.pg_advisory_xact_lock(v_new_project_lock);
    ELSE
      PERFORM pg_catalog.pg_advisory_xact_lock(v_new_project_lock);
      PERFORM pg_catalog.pg_advisory_xact_lock(v_old_project_lock);
    END IF;
  ELSE
    PERFORM pg_catalog.pg_advisory_xact_lock(v_new_project_lock);
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.member_email_links mel
    WHERE mel.project_id = NEW.project_id
      AND mel.id IS DISTINCT FROM NEW.id
      AND mel.linked_user_id = NEW.member_user_id
  ) OR (
    NEW.linked_user_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.member_email_links mel
      WHERE mel.project_id = NEW.project_id
        AND mel.id IS DISTINCT FROM NEW.id
        AND mel.member_user_id = NEW.linked_user_id
    )
  ) THEN
    RAISE EXCEPTION
      'uma identidade não pode ser alias e membro canônico no mesmo projeto'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_terminal_member_email_alias()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS enforce_terminal_member_email_alias_trigger
  ON public.member_email_links;
CREATE TRIGGER enforce_terminal_member_email_alias_trigger
  BEFORE INSERT OR UPDATE ON public.member_email_links
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_terminal_member_email_alias();

-- ========== 2. Funções de acesso com precedência canônica ==========
-- Se há alias no projeto, a membership bruta da conta não participa do
-- resultado. Isso impede somar papel ou flags de duas identidades distintas.
CREATE OR REPLACE FUNCTION public.auth_user_project_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT pm.project_id
  FROM public.project_members pm
  WHERE pm.user_id = public.clerk_uid()
    AND NOT EXISTS (
      SELECT 1
      FROM public.member_email_links mel
      WHERE mel.project_id = pm.project_id
        AND mel.linked_user_id = public.clerk_uid()
    )
  UNION ALL
  SELECT pm.project_id
  FROM public.member_email_links mel
  JOIN public.project_members pm
    ON pm.project_id = mel.project_id
   AND pm.user_id = mel.member_user_id
  WHERE mel.linked_user_id = public.clerk_uid()
$$;

CREATE OR REPLACE FUNCTION public.auth_user_coordinator_project_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT pm.project_id
  FROM public.project_members pm
  WHERE pm.user_id = public.clerk_uid()
    AND pm.role = 'coordenador'
    AND NOT EXISTS (
      SELECT 1
      FROM public.member_email_links mel
      WHERE mel.project_id = pm.project_id
        AND mel.linked_user_id = public.clerk_uid()
    )
  UNION ALL
  SELECT pm.project_id
  FROM public.member_email_links mel
  JOIN public.project_members pm
    ON pm.project_id = mel.project_id
   AND pm.user_id = mel.member_user_id
  WHERE mel.linked_user_id = public.clerk_uid()
    AND pm.role = 'coordenador'
$$;

CREATE OR REPLACE FUNCTION public.auth_user_accessible_project_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT canonical.project_id
  FROM public.auth_user_project_ids() AS canonical(project_id)
  UNION
  SELECT p.id
  FROM public.projects p
  WHERE p.created_by = public.clerk_uid()
$$;

CREATE OR REPLACE FUNCTION public.auth_user_coordinator_or_creator_project_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT canonical.project_id
  FROM public.auth_user_coordinator_project_ids() AS canonical(project_id)
  UNION
  SELECT p.id
  FROM public.projects p
  WHERE p.created_by = public.clerk_uid()
$$;

CREATE OR REPLACE FUNCTION public.auth_user_resolver_project_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT pm.project_id
  FROM public.project_members pm
  WHERE pm.user_id = public.clerk_uid()
    AND pm.can_resolve
    AND NOT EXISTS (
      SELECT 1
      FROM public.member_email_links mel
      WHERE mel.project_id = pm.project_id
        AND mel.linked_user_id = public.clerk_uid()
    )
  UNION ALL
  SELECT pm.project_id
  FROM public.member_email_links mel
  JOIN public.project_members pm
    ON pm.project_id = mel.project_id
   AND pm.user_id = mel.member_user_id
  WHERE mel.linked_user_id = public.clerk_uid()
    AND pm.can_resolve
$$;

-- Uma conta exerce exatamente uma identidade de trabalho por projeto. O id
-- bruto só é válido quando não há alias; após o vínculo, apenas o membro
-- canônico passa pelas policies de own rows.
CREATE OR REPLACE FUNCTION public.auth_user_member_identity_ids(
  p_project_id UUID
)
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT mel.member_user_id
  FROM public.member_email_links mel
  WHERE mel.project_id = p_project_id
    AND mel.linked_user_id = public.clerk_uid()
  UNION ALL
  SELECT public.clerk_uid()
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.member_email_links mel
    WHERE mel.project_id = p_project_id
      AND mel.linked_user_id = public.clerk_uid()
  )
$$;

GRANT EXECUTE ON FUNCTION public.auth_user_project_ids()
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.auth_user_coordinator_project_ids()
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.auth_user_accessible_project_ids()
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.auth_user_coordinator_or_creator_project_ids()
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.auth_user_resolver_project_ids()
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.auth_user_member_identity_ids(UUID)
  TO anon, authenticated, service_role;

-- A RLS autoriza coordenadores a gerenciar memberships de terceiros. Este
-- guard separa essa autorização da autoalteração: uma conta-alias não pode
-- mudar nem a linha da conta bruta nem a linha canônica que exerce.
CREATE OR REPLACE FUNCTION public.enforce_project_members_column_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF public.clerk_uid() IS NULL OR public.is_master() THEN
    RETURN NEW;
  END IF;

  IF OLD.user_id = public.clerk_uid()
     OR OLD.user_id IN (
       SELECT public.auth_user_member_identity_ids(OLD.project_id)
     )
  THEN
    RAISE EXCEPTION 'Members cannot change their own role on project_members'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_project_members_column_guard()
  FROM PUBLIC, anon, authenticated, service_role;

-- ========== 3. Perfis dos membros de projetos acessíveis ==========
DROP POLICY IF EXISTS "Users and teammates view profiles" ON public.profiles;
DROP POLICY IF EXISTS "Project members view teammate profiles" ON public.profiles;
CREATE POLICY "Users and teammates view profiles" ON public.profiles
  FOR SELECT
  USING (
    id = public.clerk_uid()
    OR public.is_master()
    OR EXISTS (
      SELECT 1
      FROM public.project_members teammate
      WHERE teammate.user_id = profiles.id
        AND teammate.project_id IN (
          SELECT accessible.project_id
          FROM public.auth_user_accessible_project_ids()
            AS accessible(project_id)
        )
    )
  );

-- ========== 4. Vereditos e equivalências usam identidade canônica ==========
DROP POLICY IF EXISTS "Members can view acknowledgments"
  ON public.verdict_acknowledgments;
CREATE POLICY "Members can view acknowledgments"
  ON public.verdict_acknowledgments
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.reviews review
      WHERE review.id = verdict_acknowledgments.review_id
        AND review.project_id IN (
          SELECT accessible.project_id
          FROM public.auth_user_accessible_project_ids()
            AS accessible(project_id)
        )
    )
    OR public.is_master()
  );

DROP POLICY IF EXISTS "Respondents can upsert own acknowledgments"
  ON public.verdict_acknowledgments;
CREATE POLICY "Respondents can upsert own acknowledgments"
  ON public.verdict_acknowledgments
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.reviews review
      WHERE review.id = verdict_acknowledgments.review_id
        AND verdict_acknowledgments.respondent_id IN (
          SELECT identity.user_id
          FROM public.auth_user_member_identity_ids(review.project_id)
            AS identity(user_id)
        )
    )
  );

DROP POLICY IF EXISTS "Respondents can update own acknowledgments"
  ON public.verdict_acknowledgments;
CREATE POLICY "Respondents can update own acknowledgments"
  ON public.verdict_acknowledgments
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM public.reviews review
      WHERE review.id = verdict_acknowledgments.review_id
        AND verdict_acknowledgments.respondent_id IN (
          SELECT identity.user_id
          FROM public.auth_user_member_identity_ids(review.project_id)
            AS identity(user_id)
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.reviews review
      WHERE review.id = verdict_acknowledgments.review_id
        AND verdict_acknowledgments.respondent_id IN (
          SELECT identity.user_id
          FROM public.auth_user_member_identity_ids(review.project_id)
            AS identity(user_id)
        )
    )
  );

DROP POLICY IF EXISTS "Coordinators can update verdict_acknowledgments"
  ON public.verdict_acknowledgments;
CREATE POLICY "Coordinators can update verdict_acknowledgments"
  ON public.verdict_acknowledgments
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM public.reviews review
      WHERE review.id = verdict_acknowledgments.review_id
        AND review.project_id IN (
          SELECT managed.project_id
          FROM public.auth_user_coordinator_or_creator_project_ids()
            AS managed(project_id)
        )
    )
    OR public.is_master()
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.reviews review
      WHERE review.id = verdict_acknowledgments.review_id
        AND review.project_id IN (
          SELECT managed.project_id
          FROM public.auth_user_coordinator_or_creator_project_ids()
            AS managed(project_id)
        )
    )
    OR public.is_master()
  );

DROP POLICY IF EXISTS "Members view response_equivalences"
  ON public.response_equivalences;
CREATE POLICY "Members view response_equivalences"
  ON public.response_equivalences
  FOR SELECT
  USING (
    project_id IN (
      SELECT accessible.project_id
      FROM public.auth_user_accessible_project_ids()
        AS accessible(project_id)
    )
    OR public.is_master()
  );

DROP POLICY IF EXISTS "Reviewers manage response_equivalences"
  ON public.response_equivalences;
CREATE POLICY "Reviewers manage response_equivalences"
  ON public.response_equivalences
  FOR ALL
  USING (
    reviewer_id IN (
      SELECT identity.user_id
      FROM public.auth_user_member_identity_ids(project_id)
        AS identity(user_id)
    )
    OR project_id IN (
      SELECT managed.project_id
      FROM public.auth_user_coordinator_or_creator_project_ids()
        AS managed(project_id)
    )
    OR public.is_master()
  )
  WITH CHECK (
    reviewer_id IN (
      SELECT identity.user_id
      FROM public.auth_user_member_identity_ids(project_id)
        AS identity(user_id)
    )
    OR project_id IN (
      SELECT managed.project_id
      FROM public.auth_user_coordinator_or_creator_project_ids()
        AS managed(project_id)
    )
    OR public.is_master()
  );

DROP POLICY IF EXISTS "Users view own field order"
  ON public.researcher_field_orders;
CREATE POLICY "Users view own field order"
  ON public.researcher_field_orders
  FOR SELECT
  USING (
    user_id IN (
      SELECT identity.user_id
      FROM public.auth_user_member_identity_ids(project_id)
        AS identity(user_id)
    )
    AND (
      project_id IN (
        SELECT accessible.project_id
        FROM public.auth_user_accessible_project_ids()
          AS accessible(project_id)
      )
      OR public.is_master()
    )
  );

DROP POLICY IF EXISTS "Users insert own field order"
  ON public.researcher_field_orders;
CREATE POLICY "Users insert own field order"
  ON public.researcher_field_orders
  FOR INSERT
  WITH CHECK (
    user_id IN (
      SELECT identity.user_id
      FROM public.auth_user_member_identity_ids(project_id)
        AS identity(user_id)
    )
    AND (
      project_id IN (
        SELECT accessible.project_id
        FROM public.auth_user_accessible_project_ids()
          AS accessible(project_id)
      )
      OR public.is_master()
    )
  );

DROP POLICY IF EXISTS "Users update own field order"
  ON public.researcher_field_orders;
CREATE POLICY "Users update own field order"
  ON public.researcher_field_orders
  FOR UPDATE
  USING (
    user_id IN (
      SELECT identity.user_id
      FROM public.auth_user_member_identity_ids(project_id)
        AS identity(user_id)
    )
    AND (
      project_id IN (
        SELECT accessible.project_id
        FROM public.auth_user_accessible_project_ids()
          AS accessible(project_id)
      )
      OR public.is_master()
    )
  )
  WITH CHECK (
    user_id IN (
      SELECT identity.user_id
      FROM public.auth_user_member_identity_ids(project_id)
        AS identity(user_id)
    )
    AND (
      project_id IN (
        SELECT accessible.project_id
        FROM public.auth_user_accessible_project_ids()
          AS accessible(project_id)
      )
      OR public.is_master()
    )
  );

DROP POLICY IF EXISTS "Users delete own field order"
  ON public.researcher_field_orders;
CREATE POLICY "Users delete own field order"
  ON public.researcher_field_orders
  FOR DELETE
  USING (
    user_id IN (
      SELECT identity.user_id
      FROM public.auth_user_member_identity_ids(project_id)
        AS identity(user_id)
    )
    AND (
      project_id IN (
        SELECT accessible.project_id
        FROM public.auth_user_accessible_project_ids()
          AS accessible(project_id)
      )
      OR public.is_master()
    )
  );

-- Policies antigas destas tabelas ainda consultavam project_members com o
-- id bruto, contornando os helpers canônicos. Autoria continua bruta.
DROP POLICY IF EXISTS "Members can view project comments"
  ON public.project_comments;
CREATE POLICY "Members can view project comments"
  ON public.project_comments
  FOR SELECT
  USING (
    project_id IN (
      SELECT accessible.project_id
      FROM public.auth_user_accessible_project_ids()
        AS accessible(project_id)
    )
    OR public.is_master()
  );

DROP POLICY IF EXISTS "Members can create project comments"
  ON public.project_comments;
CREATE POLICY "Members can create project comments"
  ON public.project_comments
  FOR INSERT
  WITH CHECK (
    author_id = public.clerk_uid()
    AND (
      project_id IN (
        SELECT accessible.project_id
        FROM public.auth_user_accessible_project_ids()
          AS accessible(project_id)
      )
      OR public.is_master()
    )
  );

DROP POLICY IF EXISTS "Coordinators can update project comments"
  ON public.project_comments;
CREATE POLICY "Coordinators can update project comments"
  ON public.project_comments
  FOR UPDATE
  USING (
    project_id IN (
      SELECT managed.project_id
      FROM public.auth_user_coordinator_or_creator_project_ids()
        AS managed(project_id)
    )
    OR public.is_master()
  )
  WITH CHECK (
    project_id IN (
      SELECT managed.project_id
      FROM public.auth_user_coordinator_or_creator_project_ids()
        AS managed(project_id)
    )
    OR public.is_master()
  );

DROP POLICY IF EXISTS "Members can view suggestions"
  ON public.schema_suggestions;
CREATE POLICY "Members can view suggestions"
  ON public.schema_suggestions
  FOR SELECT
  USING (
    project_id IN (
      SELECT accessible.project_id
      FROM public.auth_user_accessible_project_ids()
        AS accessible(project_id)
    )
    OR public.is_master()
  );

DROP POLICY IF EXISTS "Members can create suggestions"
  ON public.schema_suggestions;
CREATE POLICY "Members can create suggestions"
  ON public.schema_suggestions
  FOR INSERT
  WITH CHECK (
    suggested_by = public.clerk_uid()
    AND (
      project_id IN (
        SELECT accessible.project_id
        FROM public.auth_user_accessible_project_ids()
          AS accessible(project_id)
      )
      OR public.is_master()
    )
  );

DROP POLICY IF EXISTS "Coordinators can update suggestions"
  ON public.schema_suggestions;
CREATE POLICY "Coordinators can update suggestions"
  ON public.schema_suggestions
  FOR UPDATE
  USING (
    project_id IN (
      SELECT managed.project_id
      FROM public.auth_user_coordinator_or_creator_project_ids()
        AS managed(project_id)
    )
    OR public.is_master()
  )
  WITH CHECK (
    project_id IN (
      SELECT managed.project_id
      FROM public.auth_user_coordinator_or_creator_project_ids()
        AS managed(project_id)
    )
    OR public.is_master()
  );

-- ========== 5. Unificação compatível com a identidade única ==========
-- A verificação ocorre antes de qualquer mutação. Um alias source já voltado
-- ao target é reutilizado; um alias para outro target é conflito explícito.
CREATE OR REPLACE FUNCTION public.unify_project_members(
  p_project_id UUID,
  p_source_user_id UUID,
  p_target_user_id UUID,
  p_acting_user_id UUID
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_source_email TEXT;
  v_existing_alias_target UUID;
  v_locked_membership_count INTEGER;
BEGIN
  IF p_source_user_id = p_target_user_id THEN
    RAISE EXCEPTION 'source e target devem ser membros distintos';
  END IF;

  -- Mantém a mesma ordem de lock do trigger de aliases: projeto primeiro,
  -- memberships depois. Assim um insert de alias concorrente não pode segurar
  -- o advisory lock enquanto espera uma membership já bloqueada por esta RPC.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_project_id::TEXT, 0)
  );

  -- A ordem global dos UUIDs evita deadlocks entre unificações sobrepostas.
  -- Depois de aguardar um lock, READ COMMITTED reavalia a linha atualizada ou
  -- removida; por isso a contagem também é a validação de membership.
  PERFORM pm.user_id
  FROM public.project_members pm
  WHERE pm.project_id = p_project_id
    AND pm.user_id IN (p_source_user_id, p_target_user_id)
  ORDER BY pm.user_id
  FOR UPDATE;
  GET DIAGNOSTICS v_locked_membership_count = ROW_COUNT;

  IF v_locked_membership_count <> 2 THEN
    RAISE EXCEPTION 'source e target devem ser membros do projeto';
  END IF;

  SELECT mel.member_user_id
  INTO v_existing_alias_target
  FROM public.member_email_links mel
  WHERE mel.project_id = p_project_id
    AND mel.linked_user_id = p_source_user_id;

  IF v_existing_alias_target IS NOT NULL
     AND v_existing_alias_target <> p_target_user_id
  THEN
    RAISE EXCEPTION
      'source já está vinculado a outro membro canônico neste projeto'
      USING ERRCODE = '23514';
  END IF;

  -- ===== assignments (colisão: target prevalece) =====
  DELETE FROM public.assignments s
  WHERE s.project_id = p_project_id
    AND s.user_id = p_source_user_id
    AND EXISTS (
      SELECT 1 FROM public.assignments t
      WHERE t.project_id = p_project_id
        AND t.user_id = p_target_user_id
        AND t.document_id = s.document_id
        AND t.type = s.type
    );
  UPDATE public.assignments
  SET user_id = p_target_user_id
  WHERE project_id = p_project_id AND user_id = p_source_user_id;

  -- ===== responses =====
  UPDATE public.responses
  SET respondent_id = p_target_user_id
  WHERE project_id = p_project_id AND respondent_id = p_source_user_id;

  WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY document_id
             ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
           ) AS rn
    FROM public.responses
    WHERE project_id = p_project_id
      AND respondent_id = p_target_user_id
      AND respondent_type = 'humano'
      AND is_latest
  )
  UPDATE public.responses r
  SET is_latest = false
  FROM ranked
  WHERE r.id = ranked.id AND ranked.rn > 1;

  -- ===== reviews (colisão: target prevalece) =====
  DELETE FROM public.reviews s
  WHERE s.project_id = p_project_id
    AND s.reviewer_id = p_source_user_id
    AND EXISTS (
      SELECT 1 FROM public.reviews t
      WHERE t.project_id = p_project_id
        AND t.reviewer_id = p_target_user_id
        AND t.document_id = s.document_id
        AND t.field_name = s.field_name
    );
  UPDATE public.reviews
  SET reviewer_id = p_target_user_id
  WHERE project_id = p_project_id AND reviewer_id = p_source_user_id;

  -- ===== verdict_acknowledgments (target prevalece) =====
  DELETE FROM public.verdict_acknowledgments s
  WHERE s.respondent_id = p_source_user_id
    AND s.review_id IN (
      SELECT id FROM public.reviews WHERE project_id = p_project_id
    )
    AND EXISTS (
      SELECT 1 FROM public.verdict_acknowledgments t
      WHERE t.review_id = s.review_id
        AND t.respondent_id = p_target_user_id
    );
  UPDATE public.verdict_acknowledgments
  SET respondent_id = p_target_user_id
  WHERE respondent_id = p_source_user_id
    AND review_id IN (
      SELECT id FROM public.reviews WHERE project_id = p_project_id
    );

  -- ===== field_reviews =====
  UPDATE public.field_reviews
  SET self_reviewer_id = p_target_user_id
  WHERE project_id = p_project_id AND self_reviewer_id = p_source_user_id;
  UPDATE public.field_reviews
  SET arbitrator_id = p_target_user_id
  WHERE project_id = p_project_id AND arbitrator_id = p_source_user_id;

  -- ===== response_equivalences =====
  UPDATE public.response_equivalences
  SET reviewer_id = p_target_user_id
  WHERE project_id = p_project_id AND reviewer_id = p_source_user_id;

  -- Preferência pessoal do source não é herdada.
  DELETE FROM public.researcher_field_orders
  WHERE project_id = p_project_id AND user_id = p_source_user_id;

  -- Um vínculo target→source viraria self-alias após a fusão; removê-lo antes
  -- do UPDATE preserva o comportamento da RPC anterior sob o novo CHECK.
  DELETE FROM public.member_email_links
  WHERE project_id = p_project_id
    AND member_user_id = p_source_user_id
    AND linked_user_id = p_target_user_id;

  -- Vínculos que tinham o source como identidade canônica passam ao target.
  UPDATE public.member_email_links
  SET member_user_id = p_target_user_id
  WHERE project_id = p_project_id AND member_user_id = p_source_user_id;

  -- Sem alias prévio da conta source, registra o vínculo permanente. Quando
  -- ele já aponta ao mesmo target, a linha existente é a fonte única.
  IF v_existing_alias_target IS NULL THEN
    SELECT email
    INTO v_source_email
    FROM public.profiles
    WHERE id = p_source_user_id;

    IF v_source_email IS NOT NULL THEN
      INSERT INTO public.member_email_links
        (project_id, member_user_id, email, linked_user_id, created_by)
      VALUES
        (
          p_project_id,
          p_target_user_id,
          lower(v_source_email),
          p_source_user_id,
          p_acting_user_id
        );
    END IF;
  END IF;

  DELETE FROM public.project_members
  WHERE project_id = p_project_id AND user_id = p_source_user_id;
END;
$$;
