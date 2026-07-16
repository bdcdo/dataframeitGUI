-- Hardening identificado pela auditoria completa de RLS da issue #134.
--
-- Princípios aplicados aqui:
--   1. todo braço de policy baseado na identidade da linha também exige acesso
--      atual ao projeto; possuir uma linha antiga não mantém acesso revogado;
--   2. aliases, criadores e masters seguem o mesmo contrato unificado de
--      leitura definido por auth_user_accessible_project_ids();
--   3. policies escolhem linhas, enquanto triggers fail-closed limitam as
--      colunas que um pesquisador pode alterar nas próprias linhas;
--   4. funções chamadas apenas por triggers não são RPCs públicas.

-- assignment_batches é filtrada por project_id e listada por created_at DESC
-- em assignments.ts. O índice cobre exatamente esse caminho frequente.
CREATE INDEX IF NOT EXISTS idx_assignment_batches_project_created
  ON public.assignment_batches (project_id, created_at DESC);

-- Falhar com diagnóstico antes de criar constraints: além de destinos
-- duplicados, aliases não podem ser membros, apontar para não-membros ou para
-- si próprios. Esses estados formariam cadeias/ciclos que um lookup único não
-- conseguiria resolver canonicamente.
DO $$
DECLARE
  violation_count bigint;
  example_ids text;
BEGIN
  WITH invalid AS (
    SELECT link.id
    FROM public.member_email_links AS link
    WHERE link.linked_user_id IS NOT NULL
      AND (
        link.linked_user_id = link.member_user_id
        OR NOT EXISTS (
          SELECT 1 FROM public.project_members AS canonical
          WHERE canonical.project_id = link.project_id
            AND canonical.user_id = link.member_user_id
        )
        OR EXISTS (
          SELECT 1 FROM public.project_members AS alias_member
          WHERE alias_member.project_id = link.project_id
            AND alias_member.user_id = link.linked_user_id
        )
      )
    UNION
    SELECT duplicate.id
    FROM public.member_email_links AS duplicate
    WHERE duplicate.linked_user_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.member_email_links AS other
        WHERE other.project_id = duplicate.project_id
          AND other.linked_user_id = duplicate.linked_user_id
          AND other.id <> duplicate.id
      )
  )
  SELECT count(*), (
    SELECT string_agg(example.id::text, ', ' ORDER BY example.id::text)
    FROM (SELECT id FROM invalid ORDER BY id LIMIT 5) AS example
  )
  INTO violation_count, example_ids
  FROM invalid;

  IF violation_count > 0 THEN
    RAISE EXCEPTION
      'member_email_links has % invalid alias row(s); examples: %',
      violation_count, example_ids
      USING ERRCODE = '23514';
  END IF;
END;
$$;

-- Uma conta só pode exercer uma identidade canônica por projeto. Sem essa
-- invariante, cada consumidor precisaria detectar destinos divergentes depois
-- que o estado ambíguo já existisse.
CREATE UNIQUE INDEX IF NOT EXISTS member_email_links_project_linked_user_uniq
  ON public.member_email_links (project_id, linked_user_id)
  WHERE linked_user_id IS NOT NULL;

ALTER TABLE public.member_email_links
  ADD CONSTRAINT member_email_links_canonical_membership_fk
  FOREIGN KEY (project_id, member_user_id)
  REFERENCES public.project_members (project_id, user_id)
  ON DELETE CASCADE
  NOT VALID;
ALTER TABLE public.member_email_links
  VALIDATE CONSTRAINT member_email_links_canonical_membership_fk;

CREATE OR REPLACE FUNCTION public.enforce_project_alias_partition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM project.id
  FROM public.projects AS project
  WHERE project.id = NEW.project_id
  FOR UPDATE;

  IF TG_TABLE_NAME = 'member_email_links' THEN
    IF NEW.linked_user_id IS NULL THEN
      RETURN NEW;
    END IF;
    IF NEW.linked_user_id = NEW.member_user_id THEN
      RAISE EXCEPTION 'a project alias cannot point to itself'
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.project_members AS canonical
      WHERE canonical.project_id = NEW.project_id
        AND canonical.user_id = NEW.member_user_id
    ) THEN
      RAISE EXCEPTION 'canonical alias target must be a project member'
        USING ERRCODE = '23503';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.project_members AS alias_member
      WHERE alias_member.project_id = NEW.project_id
        AND alias_member.user_id = NEW.linked_user_id
    ) THEN
      RAISE EXCEPTION 'a project member cannot also be an alias login'
        USING ERRCODE = '23514';
    END IF;
  ELSIF EXISTS (
    SELECT 1 FROM public.member_email_links AS link
    WHERE link.project_id = NEW.project_id
      AND link.linked_user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'an alias login cannot also be a project member'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_project_alias_partition_on_links
  ON public.member_email_links;
CREATE TRIGGER enforce_project_alias_partition_on_links
BEFORE INSERT OR UPDATE OF project_id, member_user_id, linked_user_id
ON public.member_email_links
FOR EACH ROW EXECUTE FUNCTION public.enforce_project_alias_partition();

DROP TRIGGER IF EXISTS enforce_project_alias_partition_on_members
  ON public.project_members;
CREATE TRIGGER enforce_project_alias_partition_on_members
BEFORE INSERT OR UPDATE OF project_id, user_id
ON public.project_members
FOR EACH ROW EXECUTE FUNCTION public.enforce_project_alias_partition();

-- O bootstrap do Supabase concede privilégios de objetos public aos papéis da
-- API. A migration da view concedia authenticated/service_role, mas não
-- retirava o SELECT que anon já recebera pelo default grant.
REVOKE SELECT ON public.lottery_doc_stats FROM anon;

-- Uma conta vinculada trabalha exclusivamente como o membro canônico. A
-- função precisa existir antes das policies e guards que fixam essa identidade
-- nas escritas futuras.
CREATE OR REPLACE FUNCTION public.auth_user_effective_member_id(
  p_project_id uuid
) RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN public.clerk_uid() IS NULL OR p_project_id IS NULL THEN NULL
    ELSE COALESCE(
      (
        SELECT link.member_user_id
        FROM public.member_email_links AS link
        WHERE link.project_id = p_project_id
          AND link.linked_user_id = public.clerk_uid()
      ),
      public.clerk_uid()
    )
  END
$$;

REVOKE ALL ON FUNCTION public.auth_user_effective_member_id(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.auth_user_member_identity_ids(
  p_project_id uuid
) RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT public.auth_user_effective_member_id(p_project_id)
  WHERE public.auth_user_effective_member_id(p_project_id) IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION public.auth_user_coordinator_or_creator_project_ids()
RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT member.project_id
  FROM public.project_members AS member
  WHERE member.user_id = public.auth_user_effective_member_id(member.project_id)
    AND member.role = 'coordenador'
  UNION
  SELECT project.id
  FROM public.projects AS project
  WHERE project.created_by = public.auth_user_effective_member_id(project.id)
$$;

CREATE OR REPLACE FUNCTION public.auth_user_resolver_project_ids()
RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT member.project_id
  FROM public.project_members AS member
  WHERE member.user_id = public.auth_user_effective_member_id(member.project_id)
    AND member.can_resolve
$$;

-- ========== Leituras com o contrato de acesso unificado ==========

DROP POLICY IF EXISTS "Members view projects" ON public.projects;
CREATE POLICY "Members view projects" ON public.projects FOR SELECT USING (
  id IN (SELECT public.auth_user_accessible_project_ids())
  OR public.is_master()
);

DROP POLICY IF EXISTS "Members view members" ON public.project_members;
CREATE POLICY "Members view members" ON public.project_members FOR SELECT USING (
  project_id IN (SELECT public.auth_user_accessible_project_ids())
  OR public.is_master()
);

DROP POLICY IF EXISTS "Users and teammates view profiles" ON public.profiles;
CREATE POLICY "Users and teammates view profiles" ON public.profiles FOR SELECT USING (
  public.clerk_uid() = id
  OR public.is_master()
  OR EXISTS (
    SELECT 1
    FROM public.project_members AS teammate
    WHERE teammate.user_id = profiles.id
      AND teammate.project_id IN (SELECT public.auth_user_accessible_project_ids())
  )
);

DROP POLICY IF EXISTS "Members view difficulty_resolutions" ON public.difficulty_resolutions;
CREATE POLICY "Members view difficulty_resolutions" ON public.difficulty_resolutions FOR SELECT USING (
  project_id IN (SELECT public.auth_user_accessible_project_ids())
  OR public.is_master()
);

DROP POLICY IF EXISTS "Members view error_resolutions" ON public.error_resolutions;
CREATE POLICY "Members view error_resolutions" ON public.error_resolutions FOR SELECT USING (
  project_id IN (SELECT public.auth_user_accessible_project_ids())
  OR public.is_master()
);

DROP POLICY IF EXISTS "Members view note_resolutions" ON public.note_resolutions;
CREATE POLICY "Members view note_resolutions" ON public.note_resolutions FOR SELECT USING (
  project_id IN (SELECT public.auth_user_accessible_project_ids())
  OR public.is_master()
);

DROP POLICY IF EXISTS "Members view llm_runs" ON public.llm_runs;
CREATE POLICY "Members view llm_runs" ON public.llm_runs FOR SELECT USING (
  project_id IN (SELECT public.auth_user_accessible_project_ids())
  OR public.is_master()
);

DROP POLICY IF EXISTS "Members view rounds" ON public.rounds;
CREATE POLICY "Members view rounds" ON public.rounds FOR SELECT USING (
  project_id IN (SELECT public.auth_user_accessible_project_ids())
  OR public.is_master()
);

-- ========== Linhas próprias: acesso atual ao projeto é obrigatório ==========

DROP POLICY IF EXISTS "Researchers update own assignments" ON public.assignments;
CREATE POLICY "Researchers update own assignments" ON public.assignments FOR UPDATE
  USING (
    project_id IN (SELECT public.auth_user_accessible_project_ids())
    AND user_id IN (SELECT public.auth_user_member_identity_ids(project_id))
  )
  WITH CHECK (
    project_id IN (SELECT public.auth_user_accessible_project_ids())
    AND user_id IN (SELECT public.auth_user_member_identity_ids(project_id))
  );

DROP POLICY IF EXISTS "Users manage own responses" ON public.responses;
DROP POLICY IF EXISTS "Users insert own responses" ON public.responses;
CREATE POLICY "Users insert own responses" ON public.responses FOR INSERT
  WITH CHECK (
    project_id IN (SELECT public.auth_user_accessible_project_ids())
    AND respondent_id IN (SELECT public.auth_user_member_identity_ids(project_id))
    AND respondent_type = 'humano'
  );

DROP POLICY IF EXISTS "Users update own responses" ON public.responses;
CREATE POLICY "Users update own responses" ON public.responses FOR UPDATE
  USING (
    project_id IN (SELECT public.auth_user_accessible_project_ids())
    AND respondent_id IN (SELECT public.auth_user_member_identity_ids(project_id))
    AND respondent_type = 'humano'
  )
  WITH CHECK (
    project_id IN (SELECT public.auth_user_accessible_project_ids())
    AND respondent_id IN (SELECT public.auth_user_member_identity_ids(project_id))
    AND respondent_type = 'humano'
  );

DROP POLICY IF EXISTS "Reviewers manage reviews" ON public.reviews;

DROP POLICY IF EXISTS "Self reviewer inserts own row" ON public.field_reviews;
-- Não há chamador autenticado legítimo para INSERT: a criação inicial e o
-- reconcile usam o admin client. Manter um braço próprio permitia ao humano
-- fabricar a própria fila de auto-revisão e escolher as responses comparadas.

-- A policy histórica de coordenadores era FOR ALL e, portanto, continuava
-- oferecendo outro caminho autenticado de INSERT. O reconcile administrativo
-- usa service role após gate explícito; as fases humanas usam RPCs estreitas.
DROP POLICY IF EXISTS "Coordinators manage field_reviews" ON public.field_reviews;
DROP POLICY IF EXISTS "Coordinators update field_reviews" ON public.field_reviews;
DROP POLICY IF EXISTS "Coordinators delete field_reviews" ON public.field_reviews;
DROP POLICY IF EXISTS "Self reviewer updates own row" ON public.field_reviews;
DROP POLICY IF EXISTS "Arbitrator updates own row" ON public.field_reviews;

-- Reviews, equivalências e fases de field_reviews são máquinas de estado.
-- Usuários autenticados escrevem nelas exclusivamente pelas RPCs estreitas
-- desta migration; SELECT continua governado pelas policies existentes.
DROP POLICY IF EXISTS "Reviewers manage response_equivalences" ON public.response_equivalences;

DROP POLICY IF EXISTS "Users view own field order" ON public.researcher_field_orders;
CREATE POLICY "Users view own field order" ON public.researcher_field_orders FOR SELECT USING (
  user_id IN (SELECT public.auth_user_member_identity_ids(project_id))
  AND project_id IN (SELECT public.auth_user_accessible_project_ids())
);

DROP POLICY IF EXISTS "Users insert own field order" ON public.researcher_field_orders;
CREATE POLICY "Users insert own field order" ON public.researcher_field_orders FOR INSERT WITH CHECK (
  user_id IN (SELECT public.auth_user_member_identity_ids(project_id))
  AND project_id IN (SELECT public.auth_user_accessible_project_ids())
);

DROP POLICY IF EXISTS "Users update own field order" ON public.researcher_field_orders;
CREATE POLICY "Users update own field order" ON public.researcher_field_orders FOR UPDATE
  USING (
    user_id IN (SELECT public.auth_user_member_identity_ids(project_id))
    AND project_id IN (SELECT public.auth_user_accessible_project_ids())
  )
  WITH CHECK (
    user_id IN (SELECT public.auth_user_member_identity_ids(project_id))
    AND project_id IN (SELECT public.auth_user_accessible_project_ids())
  );

DROP POLICY IF EXISTS "Users delete own field order" ON public.researcher_field_orders;
CREATE POLICY "Users delete own field order" ON public.researcher_field_orders FOR DELETE USING (
  user_id IN (SELECT public.auth_user_member_identity_ids(project_id))
  AND project_id IN (SELECT public.auth_user_accessible_project_ids())
);

-- ========== Comentários, sugestões e acknowledgments ==========

DROP POLICY IF EXISTS "Members can view project comments" ON public.project_comments;
CREATE POLICY "Members can view project comments" ON public.project_comments FOR SELECT USING (
  project_id IN (SELECT public.auth_user_accessible_project_ids())
  OR public.is_master()
);

DROP POLICY IF EXISTS "Members can create project comments" ON public.project_comments;
CREATE POLICY "Members can create project comments" ON public.project_comments FOR INSERT WITH CHECK (
  kind <> 'exclusion_request'
  AND author_id IN (SELECT public.auth_user_member_identity_ids(project_id))
  AND (
    project_id IN (SELECT public.auth_user_accessible_project_ids())
    OR public.is_master()
  )
);

DROP POLICY IF EXISTS "Authors can update own comments" ON public.project_comments;
CREATE POLICY "Authors can update own comments" ON public.project_comments FOR UPDATE
  USING (
    kind <> 'exclusion_request'
    AND
    author_id IN (SELECT public.auth_user_member_identity_ids(project_id))
    AND project_id IN (SELECT public.auth_user_accessible_project_ids())
  )
  WITH CHECK (
    kind <> 'exclusion_request'
    AND
    author_id IN (SELECT public.auth_user_member_identity_ids(project_id))
    AND project_id IN (SELECT public.auth_user_accessible_project_ids())
  );

DROP POLICY IF EXISTS "Authors can delete own pending exclusion requests" ON public.project_comments;
CREATE POLICY "Authors can delete own pending exclusion requests" ON public.project_comments FOR DELETE USING (
  kind = 'exclusion_request'
  AND author_id IN (SELECT public.auth_user_member_identity_ids(project_id))
  AND resolved_at IS NULL
  AND rejected_at IS NULL
  AND project_id IN (SELECT public.auth_user_accessible_project_ids())
);

DROP POLICY IF EXISTS "Coordinators can update project comments" ON public.project_comments;
CREATE POLICY "Coordinators can update project comments" ON public.project_comments FOR UPDATE
  USING (
    kind <> 'exclusion_request'
    AND (
      project_id IN (SELECT public.auth_user_coordinator_or_creator_project_ids())
      OR public.is_master()
    )
  )
  WITH CHECK (
    kind <> 'exclusion_request'
    AND (
      project_id IN (SELECT public.auth_user_coordinator_or_creator_project_ids())
      OR public.is_master()
    )
  );

DROP POLICY IF EXISTS "Resolvers can update project comments" ON public.project_comments;
CREATE POLICY "Resolvers can update project comments" ON public.project_comments FOR UPDATE
  USING (
    kind <> 'exclusion_request'
    AND project_id IN (SELECT public.auth_user_resolver_project_ids())
  )
  WITH CHECK (
    kind <> 'exclusion_request'
    AND project_id IN (SELECT public.auth_user_resolver_project_ids())
  );

DROP POLICY IF EXISTS "Members can delete ambiguity comments" ON public.project_comments;

DROP POLICY IF EXISTS "Members can view suggestions" ON public.schema_suggestions;
CREATE POLICY "Members can view suggestions" ON public.schema_suggestions FOR SELECT USING (
  project_id IN (SELECT public.auth_user_accessible_project_ids())
  OR public.is_master()
);

DROP POLICY IF EXISTS "Members can create suggestions" ON public.schema_suggestions;
CREATE POLICY "Members can create suggestions" ON public.schema_suggestions FOR INSERT WITH CHECK (
  (project_id IN (SELECT public.auth_user_accessible_project_ids()) OR public.is_master())
  AND suggested_by IN (SELECT public.auth_user_member_identity_ids(project_id))
);

DROP POLICY IF EXISTS "Coordinators insert schema_change_log" ON public.schema_change_log;
CREATE POLICY "Coordinators insert schema_change_log" ON public.schema_change_log FOR INSERT WITH CHECK (
  (
    project_id IN (SELECT public.auth_user_coordinator_or_creator_project_ids())
    OR public.is_master()
  )
  AND changed_by IN (SELECT public.auth_user_member_identity_ids(project_id))
);

DROP POLICY IF EXISTS "Coordinators or resolvers insert note_resolutions" ON public.note_resolutions;
CREATE POLICY "Coordinators or resolvers insert note_resolutions" ON public.note_resolutions FOR INSERT WITH CHECK (
  resolved_by IN (SELECT public.auth_user_member_identity_ids(project_id))
  AND (
    project_id IN (SELECT public.auth_user_coordinator_or_creator_project_ids())
    OR project_id IN (SELECT public.auth_user_resolver_project_ids())
    OR public.is_master()
  )
);

DROP POLICY IF EXISTS "Coordinators can update suggestions" ON public.schema_suggestions;
CREATE POLICY "Coordinators can update suggestions" ON public.schema_suggestions FOR UPDATE
  USING (
    project_id IN (SELECT public.auth_user_coordinator_or_creator_project_ids())
    OR public.is_master()
  )
  WITH CHECK (
    project_id IN (SELECT public.auth_user_coordinator_or_creator_project_ids())
    OR public.is_master()
  );

DROP POLICY IF EXISTS "Members can view acknowledgments" ON public.verdict_acknowledgments;
CREATE POLICY "Members can view acknowledgments" ON public.verdict_acknowledgments FOR SELECT USING (
  review_id IN (
    SELECT reviews.id
    FROM public.reviews
    WHERE reviews.project_id IN (SELECT public.auth_user_accessible_project_ids())
  )
  OR public.is_master()
);

DROP POLICY IF EXISTS "Respondents can upsert own acknowledgments" ON public.verdict_acknowledgments;
CREATE POLICY "Respondents can upsert own acknowledgments" ON public.verdict_acknowledgments FOR INSERT WITH CHECK (
  respondent_id IN (
    SELECT public.auth_user_member_identity_ids(reviews.project_id)
    FROM public.reviews
    WHERE reviews.id = verdict_acknowledgments.review_id
      AND reviews.project_id IN (SELECT public.auth_user_accessible_project_ids())
  )
);

DROP POLICY IF EXISTS "Respondents can update own acknowledgments" ON public.verdict_acknowledgments;
CREATE POLICY "Respondents can update own acknowledgments" ON public.verdict_acknowledgments FOR UPDATE
  USING (
    respondent_id IN (
      SELECT public.auth_user_member_identity_ids(reviews.project_id)
      FROM public.reviews
      WHERE reviews.id = verdict_acknowledgments.review_id
        AND reviews.project_id IN (SELECT public.auth_user_accessible_project_ids())
    )
  )
  WITH CHECK (
    respondent_id IN (
      SELECT public.auth_user_member_identity_ids(reviews.project_id)
      FROM public.reviews
      WHERE reviews.id = verdict_acknowledgments.review_id
        AND reviews.project_id IN (SELECT public.auth_user_accessible_project_ids())
    )
  );

DROP POLICY IF EXISTS "Coordinators can update verdict_acknowledgments" ON public.verdict_acknowledgments;
CREATE POLICY "Coordinators can update verdict_acknowledgments" ON public.verdict_acknowledgments FOR UPDATE
  USING (
    review_id IN (
      SELECT reviews.id
      FROM public.reviews
      WHERE reviews.project_id IN (SELECT public.auth_user_coordinator_or_creator_project_ids())
    )
    OR public.is_master()
  )
  WITH CHECK (
    review_id IN (
      SELECT reviews.id
      FROM public.reviews
      WHERE reviews.project_id IN (SELECT public.auth_user_coordinator_or_creator_project_ids())
    )
    OR public.is_master()
  );

-- ========== Guardas de coluna fail-closed ==========

CREATE OR REPLACE FUNCTION public.enforce_project_comment_scope_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid uuid := public.clerk_uid();
  actor_id uuid;
  allowed_columns text[] := ARRAY[]::text[];
BEGIN
  -- A unificação de membros é uma RPC service-role-only e reconcilia autoria
  -- histórica. As FKs compostas continuam valendo; o contrato de transição de
  -- usuário autenticado começa abaixo.
  IF uid IS NULL THEN
    RETURN NEW;
  END IF;
  actor_id := public.auth_user_effective_member_id(
    CASE WHEN TG_OP = 'INSERT' THEN NEW.project_id ELSE OLD.project_id END
  );

  -- Pedido de exclusão não é comentário genérico: depois de criado, seu
  -- estado só muda pela decisão transacional ou pelo trigger que espelha a
  -- exclusão do documento. As policies já retiram UPDATE direto; este ramo
  -- mantém o contrato mesmo para caminhos que ignoram RLS.
  IF TG_OP = 'UPDATE' AND OLD.kind = 'exclusion_request' THEN
    IF (to_jsonb(NEW) - ARRAY[
          'resolved_at', 'resolved_by', 'rejected_at', 'rejected_reason'
        ]::text[])
       IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY[
          'resolved_at', 'resolved_by', 'rejected_at', 'rejected_reason'
        ]::text[]) THEN
      RAISE EXCEPTION 'exclusion request identity and content are immutable'
        USING ERRCODE = '42501';
    END IF;

    IF NEW.rejected_at IS NOT NULL THEN
      IF OLD.resolved_at IS NOT NULL
         OR OLD.rejected_at IS NOT NULL
         OR NEW.resolved_at IS NOT NULL
         OR NEW.rejected_at IS DISTINCT FROM transaction_timestamp()
         OR NULLIF(btrim(NEW.rejected_reason), '') IS NULL
         OR NEW.resolved_by IS DISTINCT FROM actor_id THEN
        RAISE EXCEPTION 'invalid exclusion request rejection transition'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;

    IF NEW.resolved_at IS NOT NULL THEN
      IF OLD.resolved_at IS NOT NULL
         OR OLD.rejected_at IS NOT NULL
         OR NEW.rejected_at IS NOT NULL
         OR NOT EXISTS (
           SELECT 1
           FROM public.documents AS document
           WHERE document.id = NEW.document_id
             AND document.project_id = NEW.project_id
             AND document.excluded_at IS NOT NULL
             AND document.excluded_at = NEW.resolved_at
             AND document.excluded_by IS NOT DISTINCT FROM NEW.resolved_by
         ) THEN
        RAISE EXCEPTION 'invalid exclusion request approval transition'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'exclusion requests cannot be reopened or edited'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.author_id IS DISTINCT FROM actor_id
       OR NEW.resolved_at IS NOT NULL
       OR NEW.resolved_by IS NOT NULL
       OR NEW.rejected_at IS NOT NULL
       OR NEW.rejected_reason IS NOT NULL THEN
      RAISE EXCEPTION 'authenticated comments require caller authorship and unresolved metadata'
        USING ERRCODE = '42501';
    END IF;

    -- Timestamps de auditoria são produzidos no banco, não pelo caller.
    NEW.created_at := transaction_timestamp();

    -- Se a tabela ganhar uma coluna, INSERT autenticado falha até este guard
    -- classificá-la explicitamente. Assim a allowlist também é fail-closed na
    -- evolução do schema, não apenas em UPDATE.
    IF (to_jsonb(NEW) - ARRAY[
          'id', 'project_id', 'document_id', 'field_name', 'author_id',
          'body', 'parent_id', 'resolved_at', 'resolved_by', 'created_at',
          'kind', 'rejected_at', 'rejected_reason'
        ]::text[]) IS DISTINCT FROM '{}'::jsonb THEN
      RAISE EXCEPTION 'new project_comments columns require an explicit INSERT contract'
        USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.resolved_by IS DISTINCT FROM OLD.resolved_by
     AND NEW.resolved_by IS NOT NULL
     AND NEW.resolved_by IS DISTINCT FROM actor_id THEN
    RAISE EXCEPTION 'resolved_by must identify the effective actor'
      USING ERRCODE = '42501';
  END IF;

  -- O autor edita o texto e pode resolver/reabrir o próprio comentário comum.
  IF OLD.author_id = actor_id THEN
    allowed_columns := allowed_columns || ARRAY[
      'body', 'resolved_at', 'resolved_by'
    ]::text[];
  END IF;

  -- Coordenador/criador/master decide também pedidos de exclusão.
  IF public.is_master()
     OR OLD.project_id IN (SELECT public.auth_user_coordinator_or_creator_project_ids()) THEN
    allowed_columns := allowed_columns || ARRAY[
      'body', 'resolved_at', 'resolved_by', 'rejected_at', 'rejected_reason'
    ]::text[];
  ELSIF OLD.project_id IN (SELECT public.auth_user_resolver_project_ids()) THEN
    allowed_columns := allowed_columns || ARRAY[
      'resolved_at', 'resolved_by'
    ]::text[];
  END IF;

  IF cardinality(allowed_columns) = 0 THEN
    RAISE EXCEPTION 'actor cannot update this project comment'
      USING ERRCODE = '42501';
  END IF;

  IF (to_jsonb(NEW) - allowed_columns)
     IS DISTINCT FROM
     (to_jsonb(OLD) - allowed_columns) THEN
    RAISE EXCEPTION 'project comment update contains structural columns'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_project_comment_scope_guard_trigger ON public.project_comments;
CREATE TRIGGER enforce_project_comment_scope_guard_trigger
  BEFORE INSERT OR UPDATE ON public.project_comments
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_project_comment_scope_guard();

-- A coluna exclusion_pending_at é derivada de project_comments. A versão
-- anterior só reagia a campos de resolução e, num UPDATE, recalculava apenas
-- NEW.document_id. Recalcular os dois lados torna mudanças de documento/kind
-- convergentes e impede estado pendente órfão no documento antigo.
CREATE OR REPLACE FUNCTION public.recompute_exclusion_pending()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  old_document_id uuid;
  new_document_id uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE')
     AND OLD.kind = 'exclusion_request' THEN
    old_document_id := OLD.document_id;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE')
     AND NEW.kind = 'exclusion_request' THEN
    new_document_id := NEW.document_id;
  END IF;

  IF old_document_id IS NOT NULL THEN
    UPDATE public.documents AS document
    SET exclusion_pending_at = (
      SELECT min(comment.created_at)
      FROM public.project_comments AS comment
      WHERE comment.document_id = old_document_id
        AND comment.kind = 'exclusion_request'
        AND comment.resolved_at IS NULL
        AND comment.rejected_at IS NULL
    )
    WHERE document.id = old_document_id;
  END IF;

  IF new_document_id IS NOT NULL
     AND new_document_id IS DISTINCT FROM old_document_id THEN
    UPDATE public.documents AS document
    SET exclusion_pending_at = (
      SELECT min(comment.created_at)
      FROM public.project_comments AS comment
      WHERE comment.document_id = new_document_id
        AND comment.kind = 'exclusion_request'
        AND comment.resolved_at IS NULL
        AND comment.rejected_at IS NULL
    )
    WHERE document.id = new_document_id;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS maintain_exclusion_pending ON public.project_comments;
CREATE TRIGGER maintain_exclusion_pending
  AFTER INSERT OR DELETE OR UPDATE OF document_id, kind, resolved_at, rejected_at
  ON public.project_comments
  FOR EACH ROW
  EXECUTE FUNCTION public.recompute_exclusion_pending();

-- As três tabelas de resolução tinham FKs independentes. Uma policy por
-- project_id, sozinha, permitia combinar um projeto autorizado com response ou
-- documento alheio e atribuir resolved_by/timestamp a outra pessoa. Todas têm
-- o mesmo contrato de INSERT; os ramos específicos fecham seus vínculos.
CREATE OR REPLACE FUNCTION public.enforce_resolution_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid uuid := public.clerk_uid();
  actor_id uuid;
  allowed_columns text[];
BEGIN
  IF uid IS NULL THEN
    RETURN NEW;
  END IF;

  actor_id := public.auth_user_effective_member_id(NEW.project_id);
  NEW.resolved_by := actor_id;
  NEW.resolved_at := transaction_timestamp();

  allowed_columns := CASE TG_TABLE_NAME
    WHEN 'difficulty_resolutions' THEN ARRAY[
      'id', 'project_id', 'response_id', 'document_id', 'resolved_by',
      'resolved_at', 'note'
    ]::text[]
    WHEN 'error_resolutions' THEN ARRAY[
      'id', 'project_id', 'document_id', 'field_name', 'resolved_by',
      'resolved_at', 'note'
    ]::text[]
    WHEN 'note_resolutions' THEN ARRAY[
      'id', 'project_id', 'response_id', 'resolved_by', 'resolved_at', 'note'
    ]::text[]
  END;

  IF (to_jsonb(NEW) - allowed_columns) IS DISTINCT FROM '{}'::jsonb THEN
    RAISE EXCEPTION 'new resolution columns require an explicit INSERT contract'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_resolution_insert_guard_trigger
  ON public.difficulty_resolutions;
CREATE TRIGGER enforce_resolution_insert_guard_trigger
  BEFORE INSERT ON public.difficulty_resolutions
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_resolution_insert_guard();

DROP TRIGGER IF EXISTS enforce_resolution_insert_guard_trigger
  ON public.error_resolutions;
CREATE TRIGGER enforce_resolution_insert_guard_trigger
  BEFORE INSERT ON public.error_resolutions
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_resolution_insert_guard();

DROP TRIGGER IF EXISTS enforce_resolution_insert_guard_trigger
  ON public.note_resolutions;
CREATE TRIGGER enforce_resolution_insert_guard_trigger
  BEFORE INSERT ON public.note_resolutions
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_resolution_insert_guard();

CREATE OR REPLACE FUNCTION public.enforce_schema_suggestion_column_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid uuid := public.clerk_uid();
  actor_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.projects AS project WHERE project.id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'schema_suggestions require an existing project'
      USING ERRCODE = '23503';
  END IF;

  -- O service role só aparece em rotinas de unificação de identidade.
  IF uid IS NULL THEN
    RETURN NEW;
  END IF;
  actor_id := public.auth_user_effective_member_id(NEW.project_id);

  IF TG_OP = 'INSERT' THEN
    IF EXISTS (
         SELECT 1
         FROM public.projects AS project
         WHERE project.id = NEW.project_id
           AND jsonb_typeof(project.pydantic_fields) = 'array'
           AND jsonb_array_length(project.pydantic_fields) > 0
       )
       AND NOT EXISTS (
         SELECT 1
         FROM public.projects AS project
         CROSS JOIN LATERAL jsonb_array_elements(project.pydantic_fields)
           AS fields(field)
         WHERE project.id = NEW.project_id
           AND field->>'name' = NEW.field_name
       ) THEN
      RAISE EXCEPTION 'schema suggestion field_name must belong to the project schema'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.suggested_by IS DISTINCT FROM actor_id
       OR NEW.status IS DISTINCT FROM 'pending'
       OR NEW.resolved_by IS NOT NULL
       OR NEW.resolved_at IS NOT NULL
       OR NEW.rejection_reason IS NOT NULL THEN
      RAISE EXCEPTION 'new schema suggestions must be pending and owned by the caller'
        USING ERRCODE = '42501';
    END IF;

    NEW.created_at := transaction_timestamp();
    IF (to_jsonb(NEW) - ARRAY[
          'id', 'project_id', 'field_name', 'suggested_by',
          'suggested_changes', 'reason', 'status', 'resolved_by',
          'resolved_at', 'rejection_reason', 'created_at'
        ]::text[]) IS DISTINCT FROM '{}'::jsonb THEN
      RAISE EXCEPTION 'new schema_suggestions columns require an explicit INSERT contract'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.field_name IS DISTINCT FROM OLD.field_name
     OR NEW.suggested_by IS DISTINCT FROM OLD.suggested_by
     OR NEW.suggested_changes IS DISTINCT FROM OLD.suggested_changes
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'schema suggestion identity and proposal are immutable'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.status NOT IN ('approved', 'rejected')
     OR NEW.resolved_by IS DISTINCT FROM actor_id
     OR NEW.resolved_at IS NULL THEN
    RAISE EXCEPTION 'schema suggestion resolution must identify the caller'
      USING ERRCODE = '42501';
  END IF;
  NEW.resolved_at := transaction_timestamp();

  IF (to_jsonb(NEW) - ARRAY[
        'status', 'resolved_by', 'resolved_at', 'rejection_reason'
      ]::text[])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY[
        'status', 'resolved_by', 'resolved_at', 'rejection_reason'
      ]::text[]) THEN
    RAISE EXCEPTION 'schema suggestion update contains structural columns'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_schema_suggestion_column_guard_trigger
  ON public.schema_suggestions;
CREATE TRIGGER enforce_schema_suggestion_column_guard_trigger
  BEFORE INSERT OR UPDATE ON public.schema_suggestions
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_schema_suggestion_column_guard();

CREATE OR REPLACE FUNCTION public.enforce_verdict_acknowledgment_column_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid uuid := public.clerk_uid();
  project_id uuid;
  effective_id uuid;
  allowed_columns text[] := ARRAY[]::text[];
BEGIN
  SELECT review.project_id INTO project_id
  FROM public.reviews AS review
  WHERE review.id = NEW.review_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'verdict acknowledgment requires an existing review'
      USING ERRCODE = '23503';
  END IF;

  IF uid IS NULL THEN
    RETURN NEW;
  END IF;

  effective_id := public.auth_user_effective_member_id(project_id);

  IF TG_OP = 'INSERT' THEN
    IF NEW.respondent_id IS DISTINCT FROM effective_id
       OR NEW.status NOT IN ('accepted', 'questioned')
       OR NEW.resolved_at IS NOT NULL
       OR NEW.resolved_by IS NOT NULL THEN
      RAISE EXCEPTION 'new acknowledgment must belong to the unresolved caller'
        USING ERRCODE = '42501';
    END IF;

    NEW.created_at := transaction_timestamp();
    IF (to_jsonb(NEW) - ARRAY[
          'id', 'review_id', 'respondent_id', 'status', 'comment',
          'created_at', 'resolved_at', 'resolved_by'
        ]::text[]) IS DISTINCT FROM '{}'::jsonb THEN
      RAISE EXCEPTION 'new acknowledgment columns require an explicit INSERT contract'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.review_id IS DISTINCT FROM OLD.review_id
     OR NEW.respondent_id IS DISTINCT FROM OLD.respondent_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'acknowledgment identity columns are immutable'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.respondent_id = effective_id THEN
    allowed_columns := allowed_columns || ARRAY['status', 'comment']::text[];
  END IF;

  IF public.is_master()
     OR project_id IN (SELECT public.auth_user_coordinator_or_creator_project_ids())
     OR project_id IN (SELECT public.auth_user_resolver_project_ids()) THEN
    allowed_columns := allowed_columns || ARRAY['resolved_at', 'resolved_by']::text[];
    IF NEW.resolved_by IS DISTINCT FROM OLD.resolved_by
       AND NEW.resolved_by IS NOT NULL
       AND NEW.resolved_by IS DISTINCT FROM effective_id THEN
      RAISE EXCEPTION 'resolved_by must identify the effective actor'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
       AND NEW.resolved_at IS NOT NULL THEN
      NEW.resolved_at := transaction_timestamp();
    END IF;
  END IF;

  IF cardinality(allowed_columns) = 0 THEN
    RAISE EXCEPTION 'actor cannot update this acknowledgment'
      USING ERRCODE = '42501';
  END IF;

  IF (to_jsonb(NEW) - allowed_columns)
     IS DISTINCT FROM
     (to_jsonb(OLD) - allowed_columns) THEN
    RAISE EXCEPTION 'acknowledgment update contains columns outside the actor phase'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_verdict_acknowledgment_column_guard_trigger
  ON public.verdict_acknowledgments;
CREATE TRIGGER enforce_verdict_acknowledgment_column_guard_trigger
  BEFORE INSERT OR UPDATE ON public.verdict_acknowledgments
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_verdict_acknowledgment_column_guard();

CREATE OR REPLACE FUNCTION public.enforce_assignment_batch_column_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid uuid := public.clerk_uid();
  actor_id uuid;
BEGIN
  IF NEW.project_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.projects AS project WHERE project.id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'assignment_batches require an existing project'
      USING ERRCODE = '23503';
  END IF;

  -- unify_project_members reatribui created_by pelo service role.
  IF uid IS NULL THEN
    RETURN NEW;
  END IF;
  actor_id := public.auth_user_effective_member_id(NEW.project_id);

  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by IS DISTINCT FROM actor_id THEN
      RAISE EXCEPTION 'assignment batch created_by must identify the caller'
        USING ERRCODE = '42501';
    END IF;
    NEW.created_at := transaction_timestamp();

    IF (to_jsonb(NEW) - ARRAY[
          'id', 'project_id', 'created_by', 'created_at',
          'researchers_per_doc', 'docs_per_researcher', 'doc_subset_size',
          'label', 'mode', 'balancing', 'filters'
        ]::text[]) IS DISTINCT FROM '{}'::jsonb THEN
      RAISE EXCEPTION 'new assignment_batches columns require an explicit INSERT contract'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'assignment batch identity columns are immutable'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_assignment_batch_column_guard_trigger
  ON public.assignment_batches;
CREATE TRIGGER enforce_assignment_batch_column_guard_trigger
  BEFORE INSERT OR UPDATE ON public.assignment_batches
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_assignment_batch_column_guard();

CREATE OR REPLACE FUNCTION public.enforce_assignment_researcher_column_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid uuid := public.clerk_uid();
BEGIN
  IF uid IS NULL THEN
    RETURN NEW;
  END IF;

  -- ON DELETE SET NULL da FK composta é uma transição referencial, não uma
  -- edição da identidade da atribuição. Um UPDATE direto continua bloqueado
  -- enquanto o batch antigo existe.
  IF TG_OP = 'UPDATE'
     AND OLD.batch_id IS NOT NULL
     AND NEW.batch_id IS NULL
     AND (to_jsonb(NEW) - 'batch_id') IS NOT DISTINCT FROM
         (to_jsonb(OLD) - 'batch_id')
     AND NOT EXISTS (
       SELECT 1
       FROM public.assignment_batches AS batch
       WHERE batch.id = OLD.batch_id
     ) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.user_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM public.project_members AS member
      WHERE member.project_id = NEW.project_id
        AND member.user_id = NEW.user_id
    ) THEN
      RAISE EXCEPTION 'authenticated assignments require a current project member'
        USING ERRCODE = '23503';
    END IF;

    -- Apenas a policy administrativa possui INSERT; a validação acima é o
    -- contrato estrutural comum a coordenador, criador e master.
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.document_id IS DISTINCT FROM OLD.document_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.batch_id IS DISTINCT FROM OLD.batch_id THEN
    RAISE EXCEPTION 'assignment identity columns are immutable';
  END IF;

  IF public.is_master()
     OR OLD.project_id IN (SELECT public.auth_user_coordinator_or_creator_project_ids()) THEN
    IF (to_jsonb(NEW) - ARRAY['status', 'completed_at', 'type']::text[])
       IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['status', 'completed_at', 'type']::text[]) THEN
      RAISE EXCEPTION 'assignment administrative update contains structural columns';
    END IF;
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - ARRAY['status', 'completed_at']::text[])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status', 'completed_at']::text[]) THEN
    RAISE EXCEPTION 'researchers may only update status and completed_at on assignments';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_assignment_researcher_column_guard_trigger ON public.assignments;
CREATE TRIGGER enforce_assignment_researcher_column_guard_trigger
  BEFORE INSERT OR UPDATE ON public.assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_assignment_researcher_column_guard();

CREATE OR REPLACE FUNCTION public.enforce_response_owner_column_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid uuid := public.clerk_uid();
  response_project public.projects%ROWTYPE;
  canonical_answer_field_hashes jsonb;
  canonical_respondent_name text;
BEGIN
  -- Reconciliação administrativa estreita usada por unify_project_members:
  -- migra a identidade humana e recalcula is_latest sem revalidar uma resposta
  -- histórica contra o schema corrente. Nenhum conteúdo ou vínculo muda.
  IF uid IS NULL
     AND TG_OP = 'UPDATE'
     AND OLD.respondent_type = 'humano'
     AND NEW.respondent_type = 'humano'
     AND (to_jsonb(NEW) - ARRAY['respondent_id', 'is_latest']::text[])
         IS NOT DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['respondent_id', 'is_latest']::text[]) THEN
    RETURN NEW;
  END IF;

  -- A ação referencial de rounds é a única transição que pode limpar round_id
  -- fora do payload humano. Um UPDATE direto não passa enquanto a rodada existe.
  IF TG_OP = 'UPDATE'
     AND OLD.round_id IS NOT NULL
     AND NEW.round_id IS NULL
     AND (to_jsonb(NEW) - ARRAY['round_id', 'updated_at']::text[])
         IS NOT DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['round_id', 'updated_at']::text[])
     AND NOT EXISTS (
       SELECT 1 FROM public.rounds AS round WHERE round.id = OLD.round_id
     ) THEN
    NEW.updated_at := transaction_timestamp();
    RETURN NEW;
  END IF;

  SELECT project.* INTO response_project
  FROM public.projects AS project
  WHERE project.id = NEW.project_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'responses.project_id must identify a project'
      USING ERRCODE = '23503';
  END IF;

  -- O backfill administrativo altera somente a classificação histórica de
  -- versão. Ele não deve exigir que uma resposta antiga já tenha o hash do
  -- schema atual; esse é justamente o dado que o backfill está reconstruindo.
  -- A RLS não oferece UPDATE de respostas alheias, e a RPC valida o projeto.
  IF TG_OP = 'UPDATE'
     AND uid IS NOT NULL
     AND (
       public.is_master()
       OR NEW.project_id IN (
         SELECT public.auth_user_coordinator_or_creator_project_ids()
       )
     )
     AND (to_jsonb(NEW) - ARRAY[
           'schema_version_major', 'schema_version_minor',
           'schema_version_patch', 'version_inferred_from', 'updated_at'
         ]::text[])
         IS NOT DISTINCT FROM
         (to_jsonb(OLD) - ARRAY[
           'schema_version_major', 'schema_version_minor',
           'schema_version_patch', 'version_inferred_from', 'updated_at'
         ]::text[]) THEN
    NEW.updated_at := transaction_timestamp();
    RETURN NEW;
  END IF;

  IF NEW.respondent_type = 'humano' THEN
    IF NEW.respondent_id IS NULL THEN
      RAISE EXCEPTION 'human responses require respondent_id'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.pydantic_hash IS DISTINCT FROM response_project.pydantic_hash
       OR NEW.schema_version_major IS DISTINCT FROM response_project.schema_version_major
       OR NEW.schema_version_minor IS DISTINCT FROM response_project.schema_version_minor
       OR NEW.schema_version_patch IS DISTINCT FROM response_project.schema_version_patch
       OR NEW.version_inferred_from IS DISTINCT FROM 'live_save'
       OR NEW.is_latest IS DISTINCT FROM true
       OR NEW.llm_job_id IS NOT NULL
       OR NEW.llm_error IS NOT NULL THEN
      RAISE EXCEPTION 'human response metadata must match the current project schema'
        USING ERRCODE = '23514';
    END IF;

    IF response_project.round_strategy = 'manual' THEN
      IF NEW.round_id IS DISTINCT FROM response_project.current_round_id THEN
        RAISE EXCEPTION 'human response round_id must be the current project round'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.round_id IS NOT NULL THEN
      RAISE EXCEPTION 'schema-version projects cannot persist response round_id'
        USING ERRCODE = '23514';
    END IF;

    SELECT COALESCE(
      jsonb_object_agg(field->>'name', field->>'hash'),
      '{}'::jsonb
    )
    INTO canonical_answer_field_hashes
    FROM jsonb_array_elements(
      COALESCE(response_project.pydantic_fields, '[]'::jsonb)
    ) AS fields(field)
    WHERE NULLIF(field->>'name', '') IS NOT NULL
      AND NULLIF(field->>'hash', '') IS NOT NULL;

    -- A #134 mantém INSERT e UPDATE direto deliberadamente estritos: todos os
    -- hashes precisam representar o schema corrente. A gravação parcial da
    -- #216 não deve afrouxar este caminho. Ela precisa de uma RPC atômica com
    -- optimistic concurrency que ajuste/substitua apenas o braço de UPDATE,
    -- atualize o hash dos campos tocados e preserve hashes stale dos demais.
    IF COALESCE(NEW.answer_field_hashes, '{}'::jsonb)
       IS DISTINCT FROM canonical_answer_field_hashes THEN
      RAISE EXCEPTION 'human response field hashes must match the current project schema'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- O service role continua apto a gravar responses LLM. Toda sessão JWT,
  -- inclusive coordenador/master, escreve apenas sua resposta humana: tarefas
  -- administrativas sobre responses já usam o admin client.
  IF uid IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.respondent_type IS DISTINCT FROM 'humano'
     OR NEW.respondent_id IS DISTINCT FROM
        public.auth_user_effective_member_id(NEW.project_id) THEN
    RAISE EXCEPTION 'authenticated users may only write their own human response'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT COALESCE(
      NULLIF(btrim(concat_ws(' ', profile.first_name, profile.last_name)), ''),
      profile.email
    )
    INTO canonical_respondent_name
    FROM public.profiles AS profile
    WHERE profile.id = NEW.respondent_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'respondent_id must identify an existing profile'
        USING ERRCODE = '23503';
    END IF;

    NEW.respondent_name := canonical_respondent_name;
    NEW.created_at := transaction_timestamp();

    -- Colunas futuras não entram silenciosamente no contrato de INSERT.
    IF (to_jsonb(NEW) - ARRAY[
          'id', 'project_id', 'document_id', 'respondent_id',
          'respondent_type', 'respondent_name', 'answers', 'justifications',
          'is_latest', 'pydantic_hash', 'created_at', 'answer_field_hashes',
          'schema_version_major', 'schema_version_minor',
          'schema_version_patch', 'version_inferred_from', 'llm_job_id',
          'is_partial', 'llm_error', 'round_id', 'updated_at'
        ]::text[]) IS DISTINCT FROM '{}'::jsonb THEN
      RAISE EXCEPTION 'new responses columns require an explicit INSERT contract'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- updated_at é metadado do banco; o caller decide o payload, não o relógio.
  NEW.updated_at := transaction_timestamp();

  IF TG_OP = 'UPDATE' AND (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
  ) THEN
    RAISE EXCEPTION 'id and project_id are immutable on responses'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - ARRAY[
        'answers', 'justifications', 'pydantic_hash', 'answer_field_hashes',
        'schema_version_major', 'schema_version_minor', 'schema_version_patch',
        'version_inferred_from', 'round_id', 'is_partial', 'updated_at'
      ]::text[])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY[
        'answers', 'justifications', 'pydantic_hash', 'answer_field_hashes',
        'schema_version_major', 'schema_version_minor', 'schema_version_patch',
        'version_inferred_from', 'round_id', 'is_partial', 'updated_at'
      ]::text[]) THEN
    RAISE EXCEPTION 'respondents may only update the canonical human response payload'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_response_owner_column_guard_trigger ON public.responses;
CREATE TRIGGER enforce_response_owner_column_guard_trigger
  BEFORE INSERT OR UPDATE ON public.responses
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_response_owner_column_guard();

COMMENT ON FUNCTION public.enforce_response_owner_column_guard() IS
  'Issue #134: direct writes require the complete current schema hash map. Issue #216 must use an atomic optimistic-concurrency RPC and preserve stale hashes for untouched fields instead of weakening this guard.';

CREATE OR REPLACE FUNCTION public.enforce_review_owner_column_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid uuid := public.clerk_uid();
BEGIN
  -- response_snapshot é trilha de auditoria fornecida pela UI. Cada entrada
  -- precisa ser uma fotografia fiel das responses do mesmo documento/campo;
  -- sem esta validação o caller podia persistir IDs, nomes e respostas
  -- inventados mesmo quando chosen_response_id era válido.
  IF NEW.response_snapshot IS NOT NULL
     AND (
       TG_OP = 'INSERT'
       OR NEW.response_snapshot IS DISTINCT FROM OLD.response_snapshot
     ) THEN
    IF jsonb_typeof(NEW.response_snapshot) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'reviews.response_snapshot must be a JSON array'
        USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(NEW.response_snapshot) AS items(item)
      LEFT JOIN public.responses AS response
        ON response.id = (item->>'id')::uuid
      WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
        OR (item - ARRAY[
              'id', 'respondent_name', 'respondent_type', 'answer',
              'justification'
            ]::text[]) IS DISTINCT FROM '{}'::jsonb
        OR response.id IS NULL
        OR response.project_id IS DISTINCT FROM NEW.project_id
        OR response.document_id IS DISTINCT FROM NEW.document_id
        OR item->>'respondent_name' IS DISTINCT FROM response.respondent_name
        OR item->>'respondent_type' IS DISTINCT FROM response.respondent_type
        OR item->'answer' IS DISTINCT FROM response.answers->NEW.field_name
        OR (
          item ? 'justification'
          AND item->'justification'
              IS DISTINCT FROM response.justifications->NEW.field_name
        )
    ) OR (
      SELECT count(DISTINCT item->>'id')
      FROM jsonb_array_elements(NEW.response_snapshot) AS items(item)
    ) IS DISTINCT FROM (
      SELECT count(*)
      FROM jsonb_array_elements(NEW.response_snapshot)
    ) THEN
      RAISE EXCEPTION 'reviews.response_snapshot must match the selected responses'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF uid IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
       SELECT 1
       FROM public.projects AS project
       WHERE project.id = NEW.project_id
         AND jsonb_typeof(project.pydantic_fields) = 'array'
         AND jsonb_array_length(project.pydantic_fields) > 0
     )
     AND NOT EXISTS (
       SELECT 1
       FROM public.projects AS project
       CROSS JOIN LATERAL jsonb_array_elements(project.pydantic_fields)
         AS fields(field)
       WHERE project.id = NEW.project_id
         AND field->>'name' = NEW.field_name
     ) THEN
    RAISE EXCEPTION 'review field_name must belong to the current project schema'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' AND NEW.reviewer_id NOT IN (
    SELECT public.auth_user_member_identity_ids(NEW.project_id)
  ) THEN
    RAISE EXCEPTION 'reviewer_id must identify the effective actor'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.resolved_at IS NOT NULL OR NEW.resolved_by IS NOT NULL THEN
      RAISE EXCEPTION 'new reviews cannot forge resolution metadata'
        USING ERRCODE = '42501';
    END IF;

    NEW.created_at := transaction_timestamp();

    IF (to_jsonb(NEW) - ARRAY[
          'id', 'project_id', 'document_id', 'field_name', 'reviewer_id',
          'verdict', 'chosen_response_id', 'comment', 'created_at',
          'resolved_at', 'resolved_by', 'response_snapshot'
        ]::text[]) IS DISTINCT FROM '{}'::jsonb THEN
      RAISE EXCEPTION 'new reviews columns require an explicit INSERT contract'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.document_id IS DISTINCT FROM OLD.document_id
    OR NEW.field_name IS DISTINCT FROM OLD.field_name
    OR NEW.reviewer_id IS DISTINCT FROM OLD.reviewer_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'review identity columns are immutable'
      USING ERRCODE = '42501';
  END IF;

  IF (
    TG_OP = 'INSERT'
    AND NEW.resolved_by IS NOT NULL
    AND NEW.resolved_by NOT IN (
      SELECT public.auth_user_member_identity_ids(NEW.project_id)
    )
  ) OR (
    TG_OP = 'UPDATE'
    AND NEW.resolved_by IS DISTINCT FROM OLD.resolved_by
    AND NEW.resolved_by IS NOT NULL
    AND NEW.resolved_by NOT IN (
      SELECT public.auth_user_member_identity_ids(NEW.project_id)
    )
  ) THEN
    RAISE EXCEPTION 'resolved_by must identify the effective actor'
      USING ERRCODE = '42501';
  END IF;

  -- Coordenadores/criadores/master podem resolver reviews de terceiros, mas
  -- não trocar sua autoria nem atribuir resolved_by a outra identidade.
  IF public.is_master()
     OR NEW.project_id IN (SELECT public.auth_user_coordinator_or_creator_project_ids()) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - ARRAY[
        'verdict', 'chosen_response_id', 'comment', 'resolved_at', 'resolved_by',
        'response_snapshot'
      ]::text[])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY[
        'verdict', 'chosen_response_id', 'comment', 'resolved_at', 'resolved_by',
        'response_snapshot'
      ]::text[]) THEN
    RAISE EXCEPTION 'reviewers may only update the review decision payload'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_review_owner_column_guard_trigger ON public.reviews;
CREATE TRIGGER enforce_review_owner_column_guard_trigger
  BEFORE INSERT OR UPDATE ON public.reviews
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_review_owner_column_guard();

-- A policy reconhece a identidade efetiva, mas FKs simples ainda permitiam
-- combinar project_id acessível com documento e responses de outro projeto ou
-- registrar reviewer_id alheio. O guard fecha o domínio da equivalência.
CREATE OR REPLACE FUNCTION public.enforce_response_equivalence_scope_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid uuid := public.clerk_uid();
BEGIN
  IF uid IS NULL THEN
    RETURN NEW;
  END IF;

  IF (
       TG_OP = 'INSERT'
       OR (
         TG_OP = 'UPDATE'
         AND NEW.field_name IS DISTINCT FROM OLD.field_name
       )
     )
     AND EXISTS (
       SELECT 1
       FROM public.projects AS project
       WHERE project.id = NEW.project_id
         AND jsonb_typeof(project.pydantic_fields) = 'array'
         AND jsonb_array_length(project.pydantic_fields) > 0
     )
     AND NOT EXISTS (
       SELECT 1
       FROM public.projects AS project
       CROSS JOIN LATERAL jsonb_array_elements(project.pydantic_fields)
         AS fields(field)
       WHERE project.id = NEW.project_id
         AND field->>'name' = NEW.field_name
     ) THEN
    RAISE EXCEPTION 'response equivalence field_name must belong to the current project schema'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.reviewer_id IS NULL OR NEW.reviewer_id NOT IN (
      SELECT public.auth_user_member_identity_ids(NEW.project_id)
    ) THEN
      RAISE EXCEPTION 'reviewer_id must identify the effective actor'
        USING ERRCODE = '42501';
    END IF;

    NEW.created_at := transaction_timestamp();

    IF (to_jsonb(NEW) - ARRAY[
          'id', 'project_id', 'document_id', 'field_name', 'response_a_id',
          'response_b_id', 'reviewer_id', 'created_at'
        ]::text[]) IS DISTINCT FROM '{}'::jsonb THEN
      RAISE EXCEPTION 'new response_equivalences columns require an explicit INSERT contract'
        USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.document_id IS DISTINCT FROM OLD.document_id
     OR NEW.response_a_id IS DISTINCT FROM OLD.response_a_id
     OR NEW.response_b_id IS DISTINCT FROM OLD.response_b_id
     OR NEW.reviewer_id IS DISTINCT FROM OLD.reviewer_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'response equivalence identity columns are immutable'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.reviewer_id NOT IN (
       SELECT public.auth_user_member_identity_ids(OLD.project_id)
     )
     AND NOT public.is_master()
     AND OLD.project_id NOT IN (
       SELECT public.auth_user_coordinator_or_creator_project_ids()
     ) THEN
    RAISE EXCEPTION 'actor cannot update this response equivalence'
      USING ERRCODE = '42501';
  END IF;

  IF (to_jsonb(NEW) - ARRAY['field_name']::text[])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['field_name']::text[]) THEN
    RAISE EXCEPTION 'only field_name is mutable on response_equivalences'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_response_equivalence_scope_guard_trigger
  ON public.response_equivalences;
CREATE TRIGGER enforce_response_equivalence_scope_guard_trigger
  BEFORE INSERT OR UPDATE ON public.response_equivalences
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_response_equivalence_scope_guard();

CREATE OR REPLACE FUNCTION public.enforce_field_review_column_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid uuid := public.clerk_uid();
BEGIN
  -- A unificação service-role-only pode trocar apenas as duas identidades. O
  -- ramo mantém as invariantes sem reabrir a máquina de estados inteira.
  IF uid IS NULL
     AND TG_OP = 'UPDATE'
     AND (to_jsonb(NEW) - ARRAY[
           'self_reviewer_id', 'arbitrator_id',
           'changed_after_justification'
         ]::text[])
         IS NOT DISTINCT FROM
         (to_jsonb(OLD) - ARRAY[
           'self_reviewer_id', 'arbitrator_id',
           'changed_after_justification'
         ]::text[]) THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.responses AS response
      WHERE response.id = NEW.human_response_id
        AND response.respondent_type = 'humano'
        AND response.respondent_id = NEW.self_reviewer_id
    ) THEN
      RAISE EXCEPTION 'human_response_id must identify the self reviewer response in this document'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.arbitrator_id IS NOT NULL
       AND NEW.arbitrator_id = NEW.self_reviewer_id THEN
      RAISE EXCEPTION 'member unification cannot collapse self reviewer and arbitrator'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.arbitrator_id IS NOT NULL
       AND NEW.final_verdict IS NULL
       AND NOT EXISTS (
         SELECT 1
         FROM public.project_members AS member
         WHERE member.project_id = NEW.project_id
           AND member.user_id = NEW.arbitrator_id
           AND member.can_arbitrate
       ) THEN
      RAISE EXCEPTION 'arbitrator_id must identify an eligible project member'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.responses AS response
    WHERE response.id = NEW.human_response_id
      AND response.respondent_type = 'humano'
      AND response.respondent_id = NEW.self_reviewer_id
  ) THEN
    RAISE EXCEPTION 'human_response_id must identify the self reviewer response in this document'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.responses AS response
    WHERE response.id = NEW.llm_response_id
      AND response.respondent_type = 'llm'
  ) THEN
    RAISE EXCEPTION 'llm_response_id must identify an LLM response in this document'
      USING ERRCODE = '23514';
  END IF;

  -- Elegibilidade corrente governa apenas trabalho ainda aberto. Depois da
  -- decisão final, arbitrator_id é histórico e precisa sobreviver à remoção
  -- ou desabilitação posterior do membro.
  IF NEW.arbitrator_id IS NOT NULL
     AND NEW.final_verdict IS NULL
     AND NOT EXISTS (
    SELECT 1
    FROM public.project_members AS member
    WHERE member.project_id = NEW.project_id
      AND member.user_id = NEW.arbitrator_id
      AND member.can_arbitrate
  ) THEN
    RAISE EXCEPTION 'arbitrator_id must identify an eligible project member'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.arbitrator_id IS NOT NULL
     AND NEW.arbitrator_id = NEW.self_reviewer_id THEN
    RAISE EXCEPTION 'self reviewer and arbitrator must be distinct identities'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.document_id IS DISTINCT FROM OLD.document_id
    OR NEW.field_name IS DISTINCT FROM OLD.field_name
    OR NEW.human_response_id IS DISTINCT FROM OLD.human_response_id
    OR NEW.llm_response_id IS DISTINCT FROM OLD.llm_response_id
    OR NEW.self_reviewer_id IS DISTINCT FROM OLD.self_reviewer_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'field review identity columns are immutable'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF OLD.self_verdict IS NOT NULL AND (
    NEW.self_verdict IS DISTINCT FROM OLD.self_verdict
    OR NEW.self_reviewed_at IS DISTINCT FROM OLD.self_reviewed_at
    OR NEW.self_justification IS DISTINCT FROM OLD.self_justification
  ) THEN
    RAISE EXCEPTION 'self review decision is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.self_verdict IS NULL AND NEW.self_verdict IS NOT NULL THEN
    NEW.self_reviewed_at := transaction_timestamp();
  END IF;

  IF OLD.arbitrator_id IS NULL AND NEW.arbitrator_id IS NOT NULL THEN
    IF NEW.self_verdict IS DISTINCT FROM 'contesta_llm'
       OR NEW.blind_verdict IS NOT NULL
       OR NEW.final_verdict IS NOT NULL THEN
      RAISE EXCEPTION 'arbitrator can only be assigned to a pending contestation'
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.arbitrator_id IS NOT NULL AND NEW.arbitrator_id IS NULL THEN
    IF OLD.final_verdict IS NOT NULL
       OR NEW.blind_verdict IS NOT NULL
       OR NEW.blind_decided_at IS NOT NULL
       OR NEW.final_verdict IS NOT NULL
       OR NEW.final_decided_at IS NOT NULL
       OR NEW.question_improvement_suggestion IS NOT NULL
       OR NEW.arbitrator_comment IS NOT NULL THEN
      RAISE EXCEPTION 'arbitrator release must clear unfinished arbitration state'
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.arbitrator_id IS NOT NULL
        AND NEW.arbitrator_id IS DISTINCT FROM OLD.arbitrator_id THEN
    RAISE EXCEPTION 'arbitrator cannot be replaced directly'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.blind_verdict IS NOT NULL
     AND NOT (OLD.arbitrator_id IS NOT NULL AND NEW.arbitrator_id IS NULL)
     AND (
    NEW.blind_verdict IS DISTINCT FROM OLD.blind_verdict
    OR NEW.blind_decided_at IS DISTINCT FROM OLD.blind_decided_at
  ) THEN
    RAISE EXCEPTION 'blind arbitration decision is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.blind_verdict IS NULL AND NEW.blind_verdict IS NOT NULL THEN
    IF NEW.self_verdict IS DISTINCT FROM 'contesta_llm'
       OR NEW.arbitrator_id IS NULL THEN
      RAISE EXCEPTION 'blind arbitration requires an assigned contestation'
        USING ERRCODE = '23514';
    END IF;
    NEW.blind_decided_at := transaction_timestamp();
  END IF;

  IF OLD.final_verdict IS NOT NULL AND (
    NEW.final_verdict IS DISTINCT FROM OLD.final_verdict
    OR NEW.final_decided_at IS DISTINCT FROM OLD.final_decided_at
    OR NEW.question_improvement_suggestion IS DISTINCT FROM OLD.question_improvement_suggestion
    OR NEW.arbitrator_comment IS DISTINCT FROM OLD.arbitrator_comment
  ) THEN
    RAISE EXCEPTION 'final arbitration decision is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.final_verdict IS NULL AND NEW.final_verdict IS NOT NULL THEN
    IF OLD.blind_verdict IS NULL THEN
      RAISE EXCEPTION 'final arbitration requires a previously committed blind decision'
        USING ERRCODE = '23514';
    END IF;
    NEW.final_decided_at := transaction_timestamp();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_field_review_column_guard_trigger ON public.field_reviews;
CREATE TRIGGER enforce_field_review_column_guard_trigger
  BEFORE INSERT OR UPDATE ON public.field_reviews
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_field_review_column_guard();

-- ========== Relações estruturais irrepresentáveis ==========

-- Constraints declarativas abaixo validam nulabilidade, relações estruturais,
-- estados e unicidade. O preflight fica restrito às duas invariantes sem uma
-- representação declarativa equivalente.
CREATE TEMP TABLE rls_contract_violations (
  relation text NOT NULL,
  row_id uuid NOT NULL
) ON COMMIT DROP;

INSERT INTO rls_contract_violations (relation, row_id)
SELECT 'field_reviews.response_semantics', field_review.id
FROM public.field_reviews AS field_review
LEFT JOIN public.responses AS human_response
  ON human_response.id = field_review.human_response_id
 AND human_response.project_id = field_review.project_id
 AND human_response.document_id = field_review.document_id
 AND human_response.respondent_type = 'humano'
 AND human_response.respondent_id = field_review.self_reviewer_id
LEFT JOIN public.responses AS llm_response
  ON llm_response.id = field_review.llm_response_id
 AND llm_response.project_id = field_review.project_id
 AND llm_response.document_id = field_review.document_id
 AND llm_response.respondent_type = 'llm'
WHERE human_response.id IS NULL OR llm_response.id IS NULL
UNION ALL
SELECT 'field_reviews.arbitrator_semantics', field_review.id
FROM public.field_reviews AS field_review
LEFT JOIN public.project_members AS arbitrator
  ON arbitrator.project_id = field_review.project_id
 AND arbitrator.user_id = field_review.arbitrator_id
 AND arbitrator.can_arbitrate = true
WHERE field_review.arbitrator_id IS NOT NULL
  AND (
    field_review.arbitrator_id = field_review.self_reviewer_id
    OR (field_review.final_verdict IS NULL AND arbitrator.id IS NULL)
  );

DO $$
DECLARE
  violations jsonb;
BEGIN
  SELECT jsonb_object_agg(
           summary.relation,
           jsonb_build_object(
             'count', summary.total,
             'sample_ids', summary.sample_ids
           )
         )
  INTO violations
  FROM (
    SELECT grouped.relation,
           grouped.total,
           (
             SELECT jsonb_agg(sample.row_id ORDER BY sample.row_id)
             FROM (
               SELECT violation.row_id
               FROM rls_contract_violations AS violation
               WHERE violation.relation = grouped.relation
               ORDER BY violation.row_id
               LIMIT 5
             ) AS sample
           ) AS sample_ids
    FROM (
      SELECT relation, count(*) AS total
      FROM rls_contract_violations
      GROUP BY relation
    ) AS grouped
  ) AS summary;

  IF violations IS NOT NULL THEN
    RAISE EXCEPTION 'RLS contract preflight failed: %', violations
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER TABLE public.documents ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE public.assignment_batches ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE public.assignments
  ALTER COLUMN project_id SET NOT NULL,
  ALTER COLUMN document_id SET NOT NULL;
ALTER TABLE public.responses
  ALTER COLUMN project_id SET NOT NULL,
  ALTER COLUMN document_id SET NOT NULL;
ALTER TABLE public.reviews
  ALTER COLUMN project_id SET NOT NULL,
  ALTER COLUMN document_id SET NOT NULL,
  ALTER COLUMN reviewer_id SET NOT NULL;

ALTER TABLE public.documents
  ADD CONSTRAINT documents_project_id_id_key UNIQUE (project_id, id);
ALTER TABLE public.assignment_batches
  ADD CONSTRAINT assignment_batches_project_id_id_key UNIQUE (project_id, id);
ALTER TABLE public.project_comments
  ADD CONSTRAINT project_comments_project_id_id_key UNIQUE (project_id, id);
ALTER TABLE public.rounds
  ADD CONSTRAINT rounds_project_id_id_key UNIQUE (project_id, id);
ALTER TABLE public.responses
  ADD CONSTRAINT responses_project_id_id_key UNIQUE (project_id, id),
  ADD CONSTRAINT responses_project_document_id_id_key UNIQUE (project_id, document_id, id);

CREATE UNIQUE INDEX project_comments_one_pending_exclusion_per_document
  ON public.project_comments (document_id)
  WHERE kind = 'exclusion_request'
    AND document_id IS NOT NULL
    AND resolved_at IS NULL
    AND rejected_at IS NULL;

ALTER TABLE public.responses
  ADD CONSTRAINT responses_project_document_fk
    FOREIGN KEY (project_id, document_id)
    REFERENCES public.documents(project_id, id) ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT responses_project_round_fk
    FOREIGN KEY (project_id, round_id)
    REFERENCES public.rounds(project_id, id) ON DELETE SET NULL (round_id) NOT VALID;
ALTER TABLE public.assignments
  ADD CONSTRAINT assignments_project_document_fk
    FOREIGN KEY (project_id, document_id)
    REFERENCES public.documents(project_id, id) ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT assignments_project_batch_fk
    FOREIGN KEY (project_id, batch_id)
    REFERENCES public.assignment_batches(project_id, id) ON DELETE SET NULL (batch_id) NOT VALID;
ALTER TABLE public.reviews
  ADD CONSTRAINT reviews_project_document_fk
    FOREIGN KEY (project_id, document_id)
    REFERENCES public.documents(project_id, id) ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT reviews_project_document_chosen_response_fk
    FOREIGN KEY (project_id, document_id, chosen_response_id)
    REFERENCES public.responses(project_id, document_id, id) NOT VALID;
ALTER TABLE public.project_comments
  ADD CONSTRAINT project_comments_project_document_fk
    FOREIGN KEY (project_id, document_id)
    REFERENCES public.documents(project_id, id) ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT project_comments_project_parent_fk
    FOREIGN KEY (project_id, parent_id)
    REFERENCES public.project_comments(project_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE public.difficulty_resolutions
  ADD CONSTRAINT difficulty_resolutions_project_document_fk
    FOREIGN KEY (project_id, document_id)
    REFERENCES public.documents(project_id, id) ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT difficulty_resolutions_project_response_fk
    FOREIGN KEY (project_id, document_id, response_id)
    REFERENCES public.responses(project_id, document_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE public.error_resolutions
  ADD CONSTRAINT error_resolutions_project_document_fk
    FOREIGN KEY (project_id, document_id)
    REFERENCES public.documents(project_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE public.note_resolutions
  ADD CONSTRAINT note_resolutions_project_response_fk
    FOREIGN KEY (project_id, response_id)
    REFERENCES public.responses(project_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE public.response_equivalences
  ADD CONSTRAINT response_equivalences_project_document_fk
    FOREIGN KEY (project_id, document_id)
    REFERENCES public.documents(project_id, id) ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT response_equivalences_project_document_response_a_fk
    FOREIGN KEY (project_id, document_id, response_a_id)
    REFERENCES public.responses(project_id, document_id, id) ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT response_equivalences_project_document_response_b_fk
    FOREIGN KEY (project_id, document_id, response_b_id)
    REFERENCES public.responses(project_id, document_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE public.field_reviews
  ADD CONSTRAINT field_reviews_project_document_fk
    FOREIGN KEY (project_id, document_id)
    REFERENCES public.documents(project_id, id) ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT field_reviews_project_document_human_response_fk
    FOREIGN KEY (project_id, document_id, human_response_id)
    REFERENCES public.responses(project_id, document_id, id) ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT field_reviews_project_document_llm_response_fk
    FOREIGN KEY (project_id, document_id, llm_response_id)
    REFERENCES public.responses(project_id, document_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE public.projects
  ADD CONSTRAINT projects_current_project_round_fk
    FOREIGN KEY (id, current_round_id)
    REFERENCES public.rounds(project_id, id) ON DELETE SET NULL (current_round_id) NOT VALID;
ALTER TABLE public.rounds
  ADD CONSTRAINT rounds_project_source_batch_fk
    FOREIGN KEY (project_id, source_batch_id)
    REFERENCES public.assignment_batches(project_id, id) ON DELETE SET NULL (source_batch_id) NOT VALID;

ALTER TABLE public.responses VALIDATE CONSTRAINT responses_project_document_fk;
ALTER TABLE public.responses VALIDATE CONSTRAINT responses_project_round_fk;
ALTER TABLE public.assignments VALIDATE CONSTRAINT assignments_project_document_fk;
ALTER TABLE public.assignments VALIDATE CONSTRAINT assignments_project_batch_fk;
ALTER TABLE public.reviews VALIDATE CONSTRAINT reviews_project_document_fk;
ALTER TABLE public.reviews VALIDATE CONSTRAINT reviews_project_document_chosen_response_fk;
ALTER TABLE public.project_comments VALIDATE CONSTRAINT project_comments_project_document_fk;
ALTER TABLE public.project_comments VALIDATE CONSTRAINT project_comments_project_parent_fk;
ALTER TABLE public.difficulty_resolutions VALIDATE CONSTRAINT difficulty_resolutions_project_document_fk;
ALTER TABLE public.difficulty_resolutions VALIDATE CONSTRAINT difficulty_resolutions_project_response_fk;
ALTER TABLE public.error_resolutions VALIDATE CONSTRAINT error_resolutions_project_document_fk;
ALTER TABLE public.note_resolutions VALIDATE CONSTRAINT note_resolutions_project_response_fk;
ALTER TABLE public.response_equivalences VALIDATE CONSTRAINT response_equivalences_project_document_fk;
ALTER TABLE public.response_equivalences VALIDATE CONSTRAINT response_equivalences_project_document_response_a_fk;
ALTER TABLE public.response_equivalences VALIDATE CONSTRAINT response_equivalences_project_document_response_b_fk;
ALTER TABLE public.field_reviews VALIDATE CONSTRAINT field_reviews_project_document_fk;
ALTER TABLE public.field_reviews VALIDATE CONSTRAINT field_reviews_project_document_human_response_fk;
ALTER TABLE public.field_reviews VALIDATE CONSTRAINT field_reviews_project_document_llm_response_fk;
ALTER TABLE public.projects VALIDATE CONSTRAINT projects_current_project_round_fk;
ALTER TABLE public.rounds VALIDATE CONSTRAINT rounds_project_source_batch_fk;

ALTER TABLE public.responses
  DROP CONSTRAINT responses_document_id_fkey,
  DROP CONSTRAINT responses_round_id_fkey;
ALTER TABLE public.assignments
  DROP CONSTRAINT assignments_document_id_fkey,
  DROP CONSTRAINT assignments_batch_id_fkey;
ALTER TABLE public.reviews
  DROP CONSTRAINT reviews_document_id_fkey,
  DROP CONSTRAINT reviews_chosen_response_id_fkey;
ALTER TABLE public.project_comments
  DROP CONSTRAINT project_comments_document_id_fkey,
  DROP CONSTRAINT project_comments_parent_id_fkey;
ALTER TABLE public.difficulty_resolutions
  DROP CONSTRAINT difficulty_resolutions_document_id_fkey,
  DROP CONSTRAINT difficulty_resolutions_response_id_fkey;
ALTER TABLE public.error_resolutions DROP CONSTRAINT error_resolutions_document_id_fkey;
ALTER TABLE public.note_resolutions DROP CONSTRAINT note_resolutions_response_id_fkey;
ALTER TABLE public.response_equivalences
  DROP CONSTRAINT response_equivalences_document_id_fkey,
  DROP CONSTRAINT response_equivalences_response_a_id_fkey,
  DROP CONSTRAINT response_equivalences_response_b_id_fkey;
ALTER TABLE public.field_reviews
  DROP CONSTRAINT field_reviews_document_id_fkey,
  DROP CONSTRAINT field_reviews_human_response_id_fkey,
  DROP CONSTRAINT field_reviews_llm_response_id_fkey;
ALTER TABLE public.projects DROP CONSTRAINT projects_current_round_fk;
ALTER TABLE public.rounds DROP CONSTRAINT rounds_source_batch_id_fkey;

-- Os checks declarativos descrevem estados completos; o trigger abaixo
-- controla apenas as transições entre esses estados.
ALTER TABLE public.field_reviews
  ADD CONSTRAINT field_reviews_self_state_check CHECK (
    (
      self_verdict IS NULL
      AND self_reviewed_at IS NULL
      AND self_justification IS NULL
    ) OR (
      self_verdict IS NOT NULL
      AND self_reviewed_at IS NOT NULL
      AND (
        (
          self_verdict IN ('contesta_llm', 'ambiguo')
          AND NULLIF(btrim(self_justification), '') IS NOT NULL
        ) OR (
          self_verdict IN ('admite_erro', 'equivalente')
          AND self_justification IS NULL
        )
      )
    )
  ) NOT VALID,
  ADD CONSTRAINT field_reviews_arbitration_state_check CHECK (
    (
      self_verdict IS DISTINCT FROM 'contesta_llm'
      AND arbitrator_id IS NULL
      AND blind_verdict IS NULL
      AND blind_decided_at IS NULL
      AND final_verdict IS NULL
      AND final_decided_at IS NULL
      AND question_improvement_suggestion IS NULL
      AND arbitrator_comment IS NULL
    ) OR (
      self_verdict = 'contesta_llm'
      AND (arbitrator_id IS NOT NULL OR (
        blind_verdict IS NULL
        AND blind_decided_at IS NULL
        AND final_verdict IS NULL
        AND final_decided_at IS NULL
        AND question_improvement_suggestion IS NULL
        AND arbitrator_comment IS NULL
      ))
      AND ((blind_verdict IS NULL) = (blind_decided_at IS NULL))
      AND ((final_verdict IS NULL) = (final_decided_at IS NULL))
      AND (final_verdict IS NULL OR blind_verdict IS NOT NULL)
      AND (question_improvement_suggestion IS NULL OR final_verdict IS NOT NULL)
      AND (arbitrator_comment IS NULL OR final_verdict IS NOT NULL)
      AND (
        final_verdict IS NULL
        OR (
          final_verdict = 'llm'
          AND NULLIF(btrim(question_improvement_suggestion), '') IS NOT NULL
        )
        OR (
          final_verdict = 'humano'
          AND question_improvement_suggestion IS NULL
        )
      )
    )
  ) NOT VALID;

ALTER TABLE public.field_reviews VALIDATE CONSTRAINT field_reviews_self_state_check;
ALTER TABLE public.field_reviews VALIDATE CONSTRAINT field_reviews_arbitration_state_check;

ALTER TABLE public.verdict_acknowledgments
  ADD CONSTRAINT verdict_acknowledgments_status_check
  CHECK (status IN ('pending', 'accepted', 'questioned')) NOT VALID;
ALTER TABLE public.verdict_acknowledgments
  VALIDATE CONSTRAINT verdict_acknowledgments_status_check;

DROP TRIGGER IF EXISTS enforce_resolver_column_guard_trigger ON public.project_comments;
DROP FUNCTION IF EXISTS public.enforce_resolver_column_guard();

-- ========== Superfície RPC ==========

-- O bootstrap do Supabase também configura default ACLs para funções. Revogar
-- apenas as funções que já existem fecha a fotografia atual, mas reabre a
-- exposição assim que uma migration futura criar uma trigger. O REVOKE global
-- remove o EXECUTE implícito de PUBLIC; o segundo remove os grants explícitos
-- que o bootstrap adiciona no schema public. Sem FOR ROLE, o contrato segue o
-- papel que efetivamente executa migrations neste ambiente.
ALTER DEFAULT PRIVILEGES
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated, service_role;

-- O trigger de signup já qualifica public.profiles no corpo; fixe também seu
-- search_path antes de retirar a exposição direta como RPC.
ALTER FUNCTION public.handle_new_user() SET search_path = '';

-- Funções alcançadas por pg_trigger não são endpoints RPC. Derivar a lista do
-- catálogo evita que uma trigger futura seja esquecida numa allowlist manual.
DO $$
DECLARE
  function_oid oid;
BEGIN
  FOR function_oid IN
    SELECT DISTINCT procedure.oid
    FROM pg_proc AS procedure
    JOIN pg_trigger AS trigger
      ON trigger.tgfoid = procedure.oid
    WHERE procedure.pronamespace = 'public'::regnamespace
      AND NOT trigger.tgisinternal
  LOOP
    EXECUTE format(
      'REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role',
      function_oid::regprocedure
    );
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_lottery_assignments(uuid, text, uuid, jsonb, boolean) FROM PUBLIC, anon, service_role;
DROP FUNCTION public.apply_lottery_assignments(uuid, text, uuid, jsonb, boolean);

-- Assignments and the balancing settings used to compute them form one lottery
-- decision. Persist both in the same transaction so a failure cannot leave the
-- next lottery with settings different from those used by this one.
CREATE FUNCTION public.apply_lottery_assignments(
  p_project_id uuid,
  p_type text,
  p_batch_id uuid,
  p_assignments jsonb,
  p_replace boolean,
  p_participant_settings jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid uuid := public.clerk_uid();
  inserted_count integer := 0;
BEGIN
  IF uid IS NULL OR p_project_id IS NULL OR (
    NOT public.is_master()
    AND p_project_id NOT IN (
      SELECT public.auth_user_coordinator_or_creator_project_ids()
    )
  ) THEN
    RAISE EXCEPTION 'coordinator, creator, or master required'
      USING ERRCODE = '42501';
  END IF;
  IF p_type NOT IN ('codificacao', 'comparacao', 'auto_revisao', 'arbitragem')
     OR p_replace IS NULL
     OR jsonb_typeof(COALESCE(p_assignments, 'null'::jsonb)) <> 'array'
     OR jsonb_typeof(COALESCE(p_participant_settings, 'null'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'lottery inputs are invalid'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_assignments) AS item(value)
    WHERE jsonb_typeof(value) IS DISTINCT FROM 'object'
       OR (value - ARRAY['document_id', 'user_id']::text[]) IS DISTINCT FROM '{}'::jsonb
       OR NOT (value ?& ARRAY['document_id', 'user_id']::text[])
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_participant_settings) AS item(value)
    WHERE jsonb_typeof(value) IS DISTINCT FROM 'object'
       OR (value - ARRAY['user_id', 'assignment_weight', 'assignment_cap']::text[])
          IS DISTINCT FROM '{}'::jsonb
       OR NOT (value ?& ARRAY['user_id', 'assignment_weight']::text[])
  ) THEN
    RAISE EXCEPTION 'lottery rows must contain only canonical keys'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT document_id, user_id
    FROM jsonb_to_recordset(p_assignments) AS row(document_id uuid, user_id uuid)
    GROUP BY document_id, user_id
    HAVING document_id IS NULL OR user_id IS NULL OR count(*) > 1
  ) OR EXISTS (
    SELECT user_id
    FROM jsonb_to_recordset(p_participant_settings) AS row(
      user_id uuid,
      assignment_weight numeric,
      assignment_cap integer
    )
    GROUP BY user_id
    HAVING user_id IS NULL OR count(*) > 1
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_participant_settings) AS row(
      user_id uuid,
      assignment_weight numeric,
      assignment_cap integer
    )
    WHERE assignment_weight IS NULL
       OR assignment_weight <= 0
       OR (assignment_cap IS NOT NULL AND assignment_cap <= 0)
  ) THEN
    RAISE EXCEPTION 'lottery rows are invalid or duplicated'
      USING ERRCODE = '23514';
  END IF;

  PERFORM project.id
  FROM public.projects AS project
  WHERE project.id = p_project_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'project not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_batch_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.assignment_batches AS batch
    WHERE batch.id = p_batch_id
      AND batch.project_id = p_project_id
  ) THEN
    RAISE EXCEPTION 'assignment batch is outside p_project_id'
      USING ERRCODE = '23503';
  END IF;

  PERFORM member.id
  FROM public.project_members AS member
  WHERE member.project_id = p_project_id
    AND member.user_id IN (
      SELECT row.user_id
      FROM jsonb_to_recordset(p_assignments) AS row(user_id uuid)
      UNION
      SELECT row.user_id
      FROM jsonb_to_recordset(p_participant_settings) AS row(user_id uuid)
    )
  FOR UPDATE;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_assignments) AS row(document_id uuid, user_id uuid)
    LEFT JOIN public.documents AS document
      ON document.id = row.document_id
     AND document.project_id = p_project_id
    LEFT JOIN public.project_members AS member
      ON member.project_id = p_project_id
     AND member.user_id = row.user_id
    WHERE document.id IS NULL OR member.id IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_participant_settings) AS row(user_id uuid)
    LEFT JOIN public.project_members AS member
      ON member.project_id = p_project_id
     AND member.user_id = row.user_id
    WHERE member.id IS NULL
  ) THEN
    RAISE EXCEPTION 'lottery references a document or member outside p_project_id'
      USING ERRCODE = '23503';
  END IF;

  IF p_replace THEN
    DELETE FROM public.assignments AS assignment
    WHERE assignment.project_id = p_project_id
      AND assignment.status = 'pendente'
      AND assignment.type = p_type;
  END IF;

  INSERT INTO public.assignments (
    project_id, document_id, user_id, batch_id, type
  )
  SELECT p_project_id, row.document_id, row.user_id, p_batch_id, p_type
  FROM jsonb_to_recordset(p_assignments) AS row(document_id uuid, user_id uuid);
  GET DIAGNOSTICS inserted_count = ROW_COUNT;

  UPDATE public.project_members AS member
  SET assignment_weight = settings.assignment_weight,
      assignment_cap = settings.assignment_cap
  FROM jsonb_to_recordset(p_participant_settings) AS settings(
    user_id uuid,
    assignment_weight numeric,
    assignment_cap integer
  )
  WHERE member.project_id = p_project_id
    AND member.user_id = settings.user_id;

  RETURN inserted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_lottery_assignments(uuid, text, uuid, jsonb, boolean, jsonb)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.apply_lottery_assignments(uuid, text, uuid, jsonb, boolean, jsonb)
  TO authenticated;

REVOKE ALL ON FUNCTION public.replace_and_add_documents(uuid, uuid[], boolean, jsonb, jsonb) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.replace_and_add_documents(uuid, uuid[], boolean, jsonb, jsonb) TO authenticated;

-- A limpeza administrativa precisa alcançar respostas de outros membros, mas
-- não precisa de UPDATE/DELETE genérico na tabela. A RPC valida autoridade e
-- escopo antes do primeiro write e mantém os cinco passos numa transação.
CREATE OR REPLACE FUNCTION public.replace_and_add_documents(
  p_project_id uuid,
  p_existing_doc_ids uuid[],
  p_delete_responses boolean,
  p_duplicate_updates jsonb,
  p_new_documents jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid uuid := public.clerk_uid();
  v_inserted integer := 0;
BEGIN
  IF uid IS NULL OR (
    NOT public.is_master()
    AND p_project_id NOT IN (
      SELECT public.auth_user_coordinator_or_creator_project_ids()
    )
  ) THEN
    RAISE EXCEPTION 'coordinator, creator, or master required'
      USING ERRCODE = '42501';
  END IF;

  IF p_duplicate_updates IS NOT NULL
     AND jsonb_typeof(p_duplicate_updates) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'p_duplicate_updates must be a JSON array'
      USING ERRCODE = '22023';
  END IF;
  IF p_new_documents IS NOT NULL
     AND jsonb_typeof(p_new_documents) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'p_new_documents must be a JSON array'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(p_duplicate_updates, '[]'::jsonb)) AS item(value)
    WHERE jsonb_typeof(value) IS DISTINCT FROM 'object'
       OR (value - ARRAY['id', 'text', 'title', 'external_id', 'text_hash', 'metadata']::text[])
          IS DISTINCT FROM '{}'::jsonb
       OR NOT value ? 'id'
       OR NOT value ? 'text'
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(p_new_documents, '[]'::jsonb)) AS item(value)
    WHERE jsonb_typeof(value) IS DISTINCT FROM 'object'
       OR (value - ARRAY['external_id', 'title', 'text', 'text_hash', 'metadata']::text[])
          IS DISTINCT FROM '{}'::jsonb
       OR NOT value ? 'text'
  ) THEN
    RAISE EXCEPTION 'document payload contains missing or unsupported keys'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT id
    FROM jsonb_to_recordset(COALESCE(p_duplicate_updates, '[]'::jsonb)) AS update_row(id uuid)
    GROUP BY id
    HAVING id IS NULL OR count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate update ids must be non-null and unique'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(COALESCE(p_existing_doc_ids, ARRAY[]::uuid[])) AS requested(id)
    LEFT JOIN public.documents AS document
      ON document.id = requested.id AND document.project_id = p_project_id
    WHERE document.id IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(COALESCE(p_duplicate_updates, '[]'::jsonb)) AS requested(id uuid)
    LEFT JOIN public.documents AS document
      ON document.id = requested.id AND document.project_id = p_project_id
    WHERE document.id IS NULL
  ) THEN
    RAISE EXCEPTION 'document ids must belong to p_project_id'
      USING ERRCODE = '23503';
  END IF;

  -- Serializa a substituição com INSERTs que adquirem KEY SHARE no documento
  -- e com outra substituição do mesmo conjunto. A ordem UUID única evita que
  -- lotes sobrepostos escolham ordens de lock diferentes.
  PERFORM document.id
  FROM public.documents AS document
  JOIN (
    SELECT existing.id
    FROM unnest(COALESCE(p_existing_doc_ids, ARRAY[]::uuid[])) AS existing(id)
    UNION
    SELECT duplicate.id
    FROM jsonb_to_recordset(
      COALESCE(p_duplicate_updates, '[]'::jsonb)
    ) AS duplicate(id uuid)
  ) AS target ON target.id = document.id
  WHERE document.project_id = p_project_id
  ORDER BY document.id
  FOR UPDATE OF document;

  IF p_delete_responses
     AND cardinality(COALESCE(p_existing_doc_ids, ARRAY[]::uuid[])) > 0 THEN
    DELETE FROM public.reviews
    WHERE project_id = p_project_id
      AND document_id = ANY(p_existing_doc_ids);

    DELETE FROM public.responses
    WHERE project_id = p_project_id
      AND document_id = ANY(p_existing_doc_ids);

    UPDATE public.assignments
    SET status = 'pendente', completed_at = NULL
    WHERE project_id = p_project_id
      AND document_id = ANY(p_existing_doc_ids);
  END IF;

  IF jsonb_array_length(COALESCE(p_duplicate_updates, '[]'::jsonb)) > 0 THEN
    UPDATE public.documents AS document
    SET text = update_row.text,
        title = update_row.title,
        external_id = update_row.external_id,
        text_hash = update_row.text_hash,
        metadata = update_row.metadata
    FROM jsonb_to_recordset(p_duplicate_updates) AS update_row(
      id uuid,
      text text,
      title text,
      external_id text,
      text_hash text,
      metadata jsonb
    )
    WHERE document.id = update_row.id
      AND document.project_id = p_project_id;
  END IF;

  IF jsonb_array_length(COALESCE(p_new_documents, '[]'::jsonb)) > 0 THEN
    INSERT INTO public.documents (
      project_id, external_id, title, text, text_hash, metadata
    )
    SELECT p_project_id,
           new_row.external_id,
           new_row.title,
           new_row.text,
           new_row.text_hash,
           new_row.metadata
    FROM jsonb_to_recordset(p_new_documents) AS new_row(
      external_id text,
      title text,
      text text,
      text_hash text,
      metadata jsonb
    );
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
  END IF;

  RETURN v_inserted;
END;
$$;

DO $$
BEGIN
  CREATE TYPE public.exclusion_request_decision AS ENUM ('approve', 'reject');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.request_document_exclusion(
  p_project_id uuid,
  p_document_id uuid,
  p_reason text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid uuid := public.clerk_uid();
  actor_id uuid;
  request_id uuid;
  out_of_scope_enabled boolean;
  document_excluded_at timestamptz;
BEGIN
  IF uid IS NULL OR (
    NOT public.is_master()
    AND p_project_id NOT IN (SELECT public.auth_user_accessible_project_ids())
  ) THEN
    RAISE EXCEPTION 'project membership required' USING ERRCODE = '42501';
  END IF;
  actor_id := public.auth_user_effective_member_id(p_project_id);
  IF NULLIF(btrim(p_reason), '') IS NULL THEN
    RAISE EXCEPTION 'exclusion reason is required' USING ERRCODE = '22023';
  END IF;

  SELECT project.out_of_scope_enabled
  INTO out_of_scope_enabled
  FROM public.projects AS project
  WHERE project.id = p_project_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'project not found' USING ERRCODE = '23503';
  END IF;
  IF NOT out_of_scope_enabled THEN
    RAISE EXCEPTION 'document exclusion requests are disabled for this project'
      USING ERRCODE = '23514';
  END IF;

  SELECT document.excluded_at
  INTO document_excluded_at
  FROM public.documents AS document
  WHERE document.id = p_document_id
    AND document.project_id = p_project_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'document not found in project' USING ERRCODE = '23503';
  END IF;
  IF document_excluded_at IS NOT NULL THEN
    RAISE EXCEPTION 'document is already excluded' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.project_comments AS comment
    WHERE comment.document_id = p_document_id
      AND comment.kind = 'exclusion_request'
      AND comment.resolved_at IS NULL
      AND comment.rejected_at IS NULL
  ) THEN
    RAISE EXCEPTION 'document already has a pending exclusion request'
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.project_comments (
    project_id, document_id, field_name, author_id, body, parent_id, kind
  ) VALUES (
    p_project_id, p_document_id, NULL, actor_id, btrim(p_reason), NULL, 'exclusion_request'
  )
  RETURNING id INTO request_id;

  RETURN request_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.decide_exclusion_request(
  p_project_id uuid,
  p_comment_id uuid,
  p_decision public.exclusion_request_decision,
  p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid uuid := public.clerk_uid();
  actor_id uuid;
  request_row public.project_comments%ROWTYPE;
  affected_count integer;
BEGIN
  IF p_decision IS NULL THEN
    RAISE EXCEPTION 'exclusion decision is required' USING ERRCODE = '22023';
  END IF;
  IF uid IS NULL OR (
    NOT public.is_master()
    AND p_project_id NOT IN (
      SELECT public.auth_user_coordinator_or_creator_project_ids()
    )
  ) THEN
    RAISE EXCEPTION 'coordinator, creator, or master required'
      USING ERRCODE = '42501';
  END IF;
  actor_id := public.auth_user_effective_member_id(p_project_id);

  -- Descobre o documento sem adquirir lock. O fluxo manual de exclusão trava
  -- documents antes de o trigger atualizar comentários; repetir essa ordem
  -- aqui evita o ciclo comment -> document / document -> comment.
  SELECT comment.*
  INTO request_row
  FROM public.project_comments AS comment
  WHERE comment.id = p_comment_id
    AND comment.project_id = p_project_id
    AND comment.kind = 'exclusion_request';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'exclusion request not found' USING ERRCODE = '23503';
  END IF;
  IF request_row.document_id IS NOT NULL THEN
    PERFORM 1
    FROM public.documents AS document
    WHERE document.id = request_row.document_id
      AND document.project_id = p_project_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'request document not found in project' USING ERRCODE = '23503';
    END IF;
  END IF;

  -- Revalida o pedido depois de obter o lock do documento. Para pedidos
  -- órfãos, este é o primeiro e único lock relevante.
  SELECT comment.*
  INTO request_row
  FROM public.project_comments AS comment
  WHERE comment.id = p_comment_id
    AND comment.project_id = p_project_id
    AND comment.kind = 'exclusion_request'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'exclusion request not found' USING ERRCODE = '23503';
  END IF;
  IF request_row.resolved_at IS NOT NULL OR request_row.rejected_at IS NOT NULL THEN
    RAISE EXCEPTION 'exclusion request is no longer pending' USING ERRCODE = '23514';
  END IF;

  SELECT count(*)::integer
  INTO affected_count
  FROM public.project_comments AS comment
  WHERE comment.project_id = p_project_id
    AND comment.kind = 'exclusion_request'
    AND comment.resolved_at IS NULL
    AND comment.rejected_at IS NULL
    AND (
      (request_row.document_id IS NOT NULL AND comment.document_id = request_row.document_id)
      OR (request_row.document_id IS NULL AND comment.id = request_row.id)
    );

  IF p_decision = 'approve' THEN
    IF request_row.document_id IS NULL THEN
      RAISE EXCEPTION 'orphan exclusion requests cannot be approved'
        USING ERRCODE = '23514';
    END IF;
    IF NULLIF(btrim(p_reason), '') IS NOT NULL THEN
      RAISE EXCEPTION 'approval does not accept a rejection reason'
        USING ERRCODE = '22023';
    END IF;

    UPDATE public.documents AS document
    SET excluded_at = transaction_timestamp(),
        excluded_by = actor_id,
        excluded_reason = request_row.body,
        exclusion_pending_at = NULL
    WHERE document.id = request_row.document_id
      AND document.project_id = p_project_id
      AND document.excluded_at IS NULL;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'document is already excluded' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NULLIF(btrim(p_reason), '') IS NULL THEN
      RAISE EXCEPTION 'rejection reason is required' USING ERRCODE = '22023';
    END IF;

    UPDATE public.project_comments AS comment
    SET rejected_at = transaction_timestamp(),
        rejected_reason = btrim(p_reason),
        resolved_by = actor_id
    WHERE comment.project_id = p_project_id
      AND comment.kind = 'exclusion_request'
      AND comment.resolved_at IS NULL
      AND comment.rejected_at IS NULL
      AND (
        (request_row.document_id IS NOT NULL AND comment.document_id = request_row.document_id)
        OR (request_row.document_id IS NULL AND comment.id = request_row.id)
      );
  END IF;

  RETURN jsonb_build_object(
    'documentId', request_row.document_id,
    'affectedCount', affected_count
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_response_schema_versions(
  p_project_id uuid,
  p_updates jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid uuid := public.clerk_uid();
  affected integer;
BEGIN
  IF uid IS NULL OR (
    NOT public.is_master()
    AND p_project_id NOT IN (
      SELECT public.auth_user_coordinator_or_creator_project_ids()
    )
  ) THEN
    RAISE EXCEPTION 'coordinator, creator, or master required'
      USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_updates) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'p_updates must be a JSON array' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_updates) AS item(value)
    WHERE jsonb_typeof(value) IS DISTINCT FROM 'object'
       OR (value - ARRAY[
             'id', 'schema_version_major', 'schema_version_minor',
             'schema_version_patch', 'version_inferred_from'
           ]::text[]) IS DISTINCT FROM '{}'::jsonb
       OR NOT (value ?& ARRAY[
             'id', 'schema_version_major', 'schema_version_minor',
             'schema_version_patch', 'version_inferred_from'
           ]::text[])
  ) THEN
    RAISE EXCEPTION 'schema version update has an invalid shape'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT id
    FROM jsonb_to_recordset(p_updates) AS update_row(id uuid)
    GROUP BY id
    HAVING id IS NULL OR count(*) > 1
  ) THEN
    RAISE EXCEPTION 'response ids must be non-null and unique'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_updates) AS update_row(
      id uuid,
      schema_version_major integer,
      schema_version_minor integer,
      schema_version_patch integer,
      version_inferred_from text
    )
    WHERE update_row.schema_version_major IS NULL
       OR update_row.schema_version_major < 0
       OR update_row.schema_version_minor IS NULL
       OR update_row.schema_version_minor < 0
       OR update_row.schema_version_patch IS NULL
       OR update_row.schema_version_patch < 0
       OR NULLIF(btrim(update_row.version_inferred_from), '') IS NULL
  ) THEN
    RAISE EXCEPTION 'version components must be non-negative integers and source must be non-empty'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_updates) AS update_row(id uuid)
    LEFT JOIN public.responses AS response
      ON response.id = update_row.id AND response.project_id = p_project_id
    WHERE response.id IS NULL
  ) THEN
    RAISE EXCEPTION 'response update is invalid or outside p_project_id'
      USING ERRCODE = '23503';
  END IF;

  UPDATE public.responses AS response
  SET schema_version_major = update_row.schema_version_major,
      schema_version_minor = update_row.schema_version_minor,
      schema_version_patch = update_row.schema_version_patch,
      version_inferred_from = btrim(update_row.version_inferred_from)
  FROM jsonb_to_recordset(p_updates) AS update_row(
    id uuid,
    schema_version_major integer,
    schema_version_minor integer,
    schema_version_patch integer,
    version_inferred_from text
  )
  WHERE response.id = update_row.id
    AND response.project_id = p_project_id;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

-- Both review submission and standalone equivalence creation accept the same
-- response contract. Keeping the validation here prevents the two write paths
-- from drifting on latest-version and field-presence semantics.
CREATE FUNCTION public.assert_current_field_responses(
  p_project_id uuid,
  p_document_id uuid,
  p_field_name text,
  p_response_ids uuid[]
) RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NULLIF(btrim(p_field_name), '') IS NULL
     OR cardinality(COALESCE(p_response_ids, ARRAY[]::uuid[])) = 0 THEN
    RAISE EXCEPTION 'field and responses are required'
      USING ERRCODE = '22023';
  END IF;

  PERFORM response.id
  FROM public.responses AS response
  WHERE response.id = ANY(p_response_ids)
    AND response.project_id = p_project_id
    AND response.document_id = p_document_id
  ORDER BY response.id
  FOR UPDATE;

  IF (
    SELECT count(*)
    FROM public.responses AS response
    WHERE response.id = ANY(p_response_ids)
      AND response.project_id = p_project_id
      AND response.document_id = p_document_id
      AND response.is_latest
      AND response.answers ? p_field_name
  ) IS DISTINCT FROM cardinality(p_response_ids) THEN
    RAISE EXCEPTION 'responses must be current rows from the same project, document, and field'
      USING ERRCODE = '23503';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_current_field_responses(uuid, uuid, text, uuid[])
  FROM PUBLIC, anon, authenticated, service_role;

-- Uma comparação ATIVA por documento é invariante de banco, imposta pelo índice
-- parcial `assignments_one_active_comparacao_per_doc`: `concluido` fica FORA do
-- predicado, então uma comparação concluída é histórico da rodada, não trabalho
-- em aberto. Consequência para toda RPC que tire um assignment de `concluido`:
-- a linha volta a entrar no predicado do índice e colide com a comparação ativa
-- corrente do documento (23505).
--
-- O predicado abaixo repete o do índice de propósito — é a guarda PREVENTIVA,
-- consultada antes do UPDATE. Capturar depois com `EXCEPTION WHEN
-- unique_violation` não serve: aqui a violação chega tarde, quando o INSERT do
-- review e os DELETEs da mesma transação já rodaram, e o rollback os levaria
-- junto. Preferir o guard também é a escolha já registrada na migration que
-- criou o índice.
--
-- Sob concorrência (outra transação inserindo a comparação ativa entre o SELECT
-- e o UPDATE) o índice segue sendo o serializador de última instância e o 23505
-- volta a ser possível; o guard elimina o caso determinístico, não a corrida.
CREATE FUNCTION public.compare_doc_has_other_active_assignment(
  p_project_id uuid,
  p_document_id uuid,
  p_assignment_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.assignments AS other
    WHERE other.project_id = p_project_id
      AND other.document_id = p_document_id
      AND other.type = 'comparacao'
      AND other.id IS DISTINCT FROM p_assignment_id
      AND other.status IS DISTINCT FROM 'concluido'
  );
$$;

REVOKE ALL ON FUNCTION public.compare_doc_has_other_active_assignment(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.submit_compare_review(
  uuid, uuid, text, uuid, text, uuid, text, uuid[], uuid[]
);
CREATE FUNCTION public.submit_compare_review(
  p_project_id uuid,
  p_document_id uuid,
  p_field_name text,
  p_verdict text,
  p_chosen_response_id uuid,
  p_comment text,
  p_comparison_response_ids uuid[],
  p_equivalent_response_ids uuid[],
  p_complete_assignment boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid uuid := public.clerk_uid();
  actor_id uuid;
  snapshot jsonb;
  review_id uuid;
BEGIN
  actor_id := public.auth_user_effective_member_id(p_project_id);
  IF uid IS NULL OR p_project_id IS NULL
     OR (
       NOT public.is_master()
       AND p_project_id NOT IN (
         SELECT public.auth_user_accessible_project_ids()
       )
     )
     OR actor_id IS NULL THEN
    RAISE EXCEPTION 'authenticated project actor required'
      USING ERRCODE = '42501';
  END IF;
  IF NULLIF(btrim(p_field_name), '') IS NULL
     OR NULLIF(btrim(p_verdict), '') IS NULL
     OR p_complete_assignment IS NULL
     OR cardinality(COALESCE(p_comparison_response_ids, ARRAY[]::uuid[])) = 0 THEN
    RAISE EXCEPTION 'field, verdict, and comparison responses are required'
      USING ERRCODE = '22023';
  END IF;
  IF (
    SELECT count(*) FROM unnest(p_comparison_response_ids) AS response_id
  ) IS DISTINCT FROM (
    SELECT count(DISTINCT response_id) FROM unnest(p_comparison_response_ids) AS response_id
  ) THEN
    RAISE EXCEPTION 'comparison response ids must be unique'
      USING ERRCODE = '22023';
  END IF;
  IF p_chosen_response_id IS NOT NULL
     AND NOT p_chosen_response_id = ANY(p_comparison_response_ids) THEN
    RAISE EXCEPTION 'chosen response must belong to the comparison set'
      USING ERRCODE = '23514';
  END IF;
  IF p_equivalent_response_ids IS NOT NULL AND (
    cardinality(p_equivalent_response_ids) < 2
    OR EXISTS (
      SELECT 1
      FROM unnest(p_equivalent_response_ids) AS equivalent_id
      WHERE NOT equivalent_id = ANY(p_comparison_response_ids)
    )
    OR (
      SELECT count(*) FROM unnest(p_equivalent_response_ids) AS equivalent_id
    ) IS DISTINCT FROM (
      SELECT count(DISTINCT equivalent_id)
      FROM unnest(p_equivalent_response_ids) AS equivalent_id
    )
  ) THEN
    RAISE EXCEPTION 'equivalent responses must be distinct members of the comparison set'
      USING ERRCODE = '23514';
  END IF;

  PERFORM public.assert_current_field_responses(
    p_project_id, p_document_id, p_field_name, p_comparison_response_ids
  );

  SELECT jsonb_agg(
           jsonb_strip_nulls(jsonb_build_object(
             'id', response.id,
             'respondent_name', response.respondent_name,
             'respondent_type', response.respondent_type,
             'answer', response.answers -> p_field_name,
             'justification', response.justifications -> p_field_name
           ))
           ORDER BY selected.position
         )
  INTO snapshot
  FROM unnest(p_comparison_response_ids) WITH ORDINALITY AS selected(id, position)
  JOIN public.responses AS response ON response.id = selected.id;

  INSERT INTO public.reviews (
    project_id, document_id, field_name, reviewer_id, verdict,
    chosen_response_id, comment, response_snapshot
  ) VALUES (
    p_project_id, p_document_id, p_field_name, actor_id, p_verdict,
    p_chosen_response_id, NULLIF(btrim(p_comment), ''), snapshot
  )
  ON CONFLICT (project_id, document_id, field_name, reviewer_id)
  DO UPDATE SET
    verdict = EXCLUDED.verdict,
    chosen_response_id = EXCLUDED.chosen_response_id,
    comment = EXCLUDED.comment,
    response_snapshot = EXCLUDED.response_snapshot
  RETURNING id INTO review_id;

  IF p_equivalent_response_ids IS NOT NULL THEN
    INSERT INTO public.response_equivalences (
      project_id, document_id, field_name,
      response_a_id, response_b_id, reviewer_id
    )
    SELECT p_project_id,
           p_document_id,
           p_field_name,
           LEAST(left_response.id, right_response.id),
           GREATEST(left_response.id, right_response.id),
           actor_id
    FROM unnest(p_equivalent_response_ids) WITH ORDINALITY AS left_response(id, position)
    JOIN unnest(p_equivalent_response_ids) WITH ORDINALITY AS right_response(id, position)
      ON left_response.position < right_response.position
    ON CONFLICT (project_id, document_id, field_name, response_a_id, response_b_id)
      DO NOTHING;
  END IF;

  IF p_verdict = 'ambiguo' THEN
    INSERT INTO public.project_comments (
      project_id, document_id, field_name, author_id, body, kind
    ) VALUES (
      p_project_id,
      p_document_id,
      p_field_name,
      actor_id,
      CASE
        WHEN NULLIF(btrim(p_comment), '') IS NULL
          THEN 'Campo marcado como ambíguo na revisão (aba Comparar).'
        ELSE 'Campo marcado como ambíguo na revisão (aba Comparar): ' || btrim(p_comment)
      END,
      'ambiguity'
    )
    ON CONFLICT (project_id, document_id, field_name)
      WHERE kind = 'ambiguity'
    DO NOTHING;
  ELSIF NOT EXISTS (
    SELECT 1
    FROM public.reviews AS review
    WHERE review.project_id = p_project_id
      AND review.document_id = p_document_id
      AND review.field_name = p_field_name
      AND review.verdict = 'ambiguo'
  ) THEN
    DELETE FROM public.project_comments AS comment
    WHERE comment.project_id = p_project_id
      AND comment.document_id = p_document_id
      AND comment.field_name = p_field_name
      AND comment.kind = 'ambiguity';
  END IF;

  -- `p_complete_assignment = false` sobre um assignment já `concluido` é uma
  -- REGRESSÃO: reinsere a linha no predicado do índice de comparação ativa. Se
  -- o documento já tem outra comparação ativa, a concluída é histórico de uma
  -- rodada anterior e permanece como está — sem o guard, o 23505 abortaria a
  -- transação e derrubaria junto o review recém-gravado acima.
  UPDATE public.assignments AS assignment
  SET status = CASE WHEN p_complete_assignment THEN 'concluido' ELSE 'em_andamento' END,
      completed_at = CASE WHEN p_complete_assignment THEN transaction_timestamp() ELSE NULL END
  WHERE assignment.project_id = p_project_id
    AND assignment.document_id = p_document_id
    AND assignment.user_id = actor_id
    AND assignment.type = 'comparacao'
    AND (
      p_complete_assignment
      OR assignment.status IS DISTINCT FROM 'concluido'
      OR NOT public.compare_doc_has_other_active_assignment(
           p_project_id, p_document_id, assignment.id
         )
    );

  RETURN jsonb_build_object('reviewId', review_id);
END;
$$;

CREATE FUNCTION public.mark_compare_doc_reviewed(
  p_project_id uuid,
  p_document_id uuid
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := public.auth_user_effective_member_id(p_project_id);
  updated_count integer := 0;
BEGIN
  IF public.clerk_uid() IS NULL OR p_project_id IS NULL OR actor_id IS NULL
     OR (
       NOT public.is_master()
       AND p_project_id NOT IN (
         SELECT public.auth_user_accessible_project_ids()
       )
     ) THEN
    RAISE EXCEPTION 'authenticated project actor required'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.assignments AS assignment
  SET status = 'concluido',
      completed_at = transaction_timestamp()
  WHERE assignment.project_id = p_project_id
    AND assignment.document_id = p_document_id
    AND assignment.user_id = actor_id
    AND assignment.type = 'comparacao';
  GET DIAGNOSTICS updated_count = ROW_COUNT;

  IF updated_count = 0 THEN
    RAISE EXCEPTION 'comparison assignment not found'
      USING ERRCODE = '23503';
  END IF;
  RETURN updated_count;
END;
$$;

DROP FUNCTION IF EXISTS public.add_response_equivalence(uuid, uuid, text, uuid, uuid, uuid);
CREATE FUNCTION public.add_response_equivalence(
  p_project_id uuid,
  p_document_id uuid,
  p_field_name text,
  p_response_a_id uuid,
  p_response_b_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := public.auth_user_effective_member_id(p_project_id);
  equivalence_id uuid;
  v_response_a_id uuid := LEAST(p_response_a_id, p_response_b_id);
  v_response_b_id uuid := GREATEST(p_response_a_id, p_response_b_id);
BEGIN
  IF public.clerk_uid() IS NULL OR p_project_id IS NULL
     OR (
       NOT public.is_master()
       AND p_project_id NOT IN (
         SELECT public.auth_user_accessible_project_ids()
       )
     )
     OR actor_id IS NULL THEN
    RAISE EXCEPTION 'authenticated project actor required'
      USING ERRCODE = '42501';
  END IF;
  IF p_response_a_id IS NULL
     OR p_response_b_id IS NULL
     OR p_response_a_id = p_response_b_id THEN
    RAISE EXCEPTION 'two distinct responses are required'
      USING ERRCODE = '22023';
  END IF;

  PERFORM public.assert_current_field_responses(
    p_project_id,
    p_document_id,
    p_field_name,
    ARRAY[p_response_a_id, p_response_b_id]
  );

  INSERT INTO public.response_equivalences (
    project_id, document_id, field_name,
    response_a_id, response_b_id, reviewer_id
  ) VALUES (
    p_project_id, p_document_id, p_field_name,
    v_response_a_id, v_response_b_id, actor_id
  )
  ON CONFLICT (project_id, document_id, field_name, response_a_id, response_b_id)
    DO NOTHING
  RETURNING id INTO equivalence_id;

  IF equivalence_id IS NULL THEN
    SELECT equivalence.id
    INTO equivalence_id
    FROM public.response_equivalences AS equivalence
    WHERE equivalence.project_id = p_project_id
      AND equivalence.document_id = p_document_id
      AND equivalence.field_name = p_field_name
      AND equivalence.response_a_id = v_response_a_id
      AND equivalence.response_b_id = v_response_b_id;
  END IF;

  RETURN equivalence_id;
END;
$$;

DROP FUNCTION IF EXISTS public.remove_response_equivalence(uuid, uuid, uuid);
CREATE FUNCTION public.remove_response_equivalence(
  p_project_id uuid,
  p_equivalence_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := public.auth_user_effective_member_id(p_project_id);
  equivalence public.response_equivalences%ROWTYPE;
BEGIN
  IF public.clerk_uid() IS NULL OR p_project_id IS NULL
     OR (
       NOT public.is_master()
       AND p_project_id NOT IN (
         SELECT public.auth_user_accessible_project_ids()
       )
     )
     OR actor_id IS NULL THEN
    RAISE EXCEPTION 'authenticated project actor required'
      USING ERRCODE = '42501';
  END IF;

  SELECT row.*
  INTO equivalence
  FROM public.response_equivalences AS row
  WHERE row.id = p_equivalence_id
    AND row.project_id = p_project_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'equivalence not found' USING ERRCODE = '23503';
  END IF;
  IF equivalence.reviewer_id IS DISTINCT FROM actor_id
     AND NOT public.is_master()
     AND p_project_id NOT IN (
       SELECT public.auth_user_coordinator_or_creator_project_ids()
     ) THEN
    RAISE EXCEPTION 'actor cannot remove this equivalence'
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.response_equivalences WHERE id = equivalence.id;
  DELETE FROM public.reviews AS review
  WHERE review.project_id = p_project_id
    AND review.document_id = equivalence.document_id
    AND review.field_name = equivalence.field_name
    AND review.reviewer_id = actor_id;

  -- Reabre apenas a comparação de quem removeu a equivalência. Reabrir a de
  -- terceiros regrediria o parecer histórico de outro revisor e, com duas
  -- concluídas no mesmo documento, as duas entrariam juntas no predicado do
  -- índice de comparação ativa — violando-o uma contra a outra.
  --
  -- O guard cobre o caso restante: a concluída do próprio actor só reabre se o
  -- documento não tiver outra comparação ativa. Com uma nova rodada já sorteada,
  -- o parecer antigo permanece concluído por ser histórico.
  --
  -- `pendente` vs. `em_andamento` se decide pelo que sobra do actor no documento
  -- APÓS o DELETE acima: qualquer review dele em outro campo mantém o trabalho
  -- em andamento; nenhum, e a comparação volta ao início.
  UPDATE public.assignments AS assignment
  SET status = CASE
        WHEN EXISTS (
          SELECT 1
          FROM public.reviews AS review
          WHERE review.project_id = p_project_id
            AND review.document_id = equivalence.document_id
            AND review.reviewer_id = actor_id
        ) THEN 'em_andamento'
        ELSE 'pendente'
      END,
      completed_at = NULL
  WHERE assignment.project_id = p_project_id
    AND assignment.document_id = equivalence.document_id
    AND assignment.user_id = actor_id
    AND assignment.type = 'comparacao'
    AND assignment.status = 'concluido'
    AND NOT public.compare_doc_has_other_active_assignment(
          p_project_id, equivalence.document_id, assignment.id
        );

  RETURN jsonb_build_object(
    'documentId', equivalence.document_id,
    'fieldName', equivalence.field_name,
    'removedCount', 1
  );
END;
$$;

DROP FUNCTION IF EXISTS public.set_review_resolution(uuid, uuid, boolean, uuid);
CREATE FUNCTION public.set_review_resolution(
  p_project_id uuid,
  p_review_id uuid,
  p_resolved boolean
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := public.auth_user_effective_member_id(p_project_id);
  review_row public.reviews%ROWTYPE;
BEGIN
  IF p_resolved IS NULL THEN
    RAISE EXCEPTION 'p_resolved is required' USING ERRCODE = '22023';
  END IF;
  IF public.clerk_uid() IS NULL OR p_project_id IS NULL
     OR (
       NOT public.is_master()
       AND p_project_id NOT IN (
         SELECT public.auth_user_accessible_project_ids()
       )
     )
     OR actor_id IS NULL THEN
    RAISE EXCEPTION 'authenticated project actor required'
      USING ERRCODE = '42501';
  END IF;

  SELECT review.*
  INTO review_row
  FROM public.reviews AS review
  WHERE review.id = p_review_id
    AND review.project_id = p_project_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'review not found' USING ERRCODE = '23503';
  END IF;
  IF review_row.reviewer_id IS DISTINCT FROM actor_id
     AND NOT public.is_master()
     AND p_project_id NOT IN (
       SELECT public.auth_user_coordinator_or_creator_project_ids()
     )
     AND p_project_id NOT IN (
       SELECT public.auth_user_resolver_project_ids()
     ) THEN
    RAISE EXCEPTION 'actor cannot resolve this review'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.reviews
  SET resolved_at = CASE WHEN p_resolved THEN transaction_timestamp() ELSE NULL END,
      resolved_by = CASE WHEN p_resolved THEN actor_id ELSE NULL END
  WHERE id = p_review_id;
  RETURN 1;
END;
$$;

DROP FUNCTION IF EXISTS public.submit_self_review(uuid, uuid, uuid, jsonb);
CREATE FUNCTION public.submit_self_review(
  p_project_id uuid,
  p_document_id uuid,
  p_decisions jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid uuid := public.clerk_uid();
  actor_id uuid := public.auth_user_effective_member_id(p_project_id);
  updated_ids uuid[] := ARRAY[]::uuid[];
  needs_arbitrator jsonb := '[]'::jsonb;
BEGIN
  IF uid IS NULL OR p_project_id IS NULL
     OR (
       NOT public.is_master()
       AND p_project_id NOT IN (
         SELECT public.auth_user_accessible_project_ids()
       )
     )
     OR actor_id IS NULL THEN
    RAISE EXCEPTION 'authenticated project actor required'
      USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_decisions) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_decisions) = 0 THEN
    RAISE EXCEPTION 'p_decisions must be a non-empty JSON array'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_decisions) AS item(value)
    WHERE jsonb_typeof(value) IS DISTINCT FROM 'object'
       OR (value - ARRAY['fieldReviewId', 'verdict', 'justification']::text[])
          IS DISTINCT FROM '{}'::jsonb
       OR NOT (value ?& ARRAY['fieldReviewId', 'verdict']::text[])
  ) THEN
    RAISE EXCEPTION 'self review decision has an invalid shape'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT "fieldReviewId"
    FROM jsonb_to_recordset(p_decisions) AS decision(
      "fieldReviewId" uuid, verdict text, justification text
    )
    GROUP BY "fieldReviewId"
    HAVING "fieldReviewId" IS NULL OR count(*) > 1
  ) THEN
    RAISE EXCEPTION 'fieldReviewId values must be non-null and unique'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_decisions) AS decision(
      "fieldReviewId" uuid, verdict text, justification text
    )
    WHERE decision.verdict NOT IN (
      'admite_erro', 'contesta_llm', 'equivalente', 'ambiguo'
    )
       OR (
         decision.verdict IN ('contesta_llm', 'ambiguo')
         AND NULLIF(btrim(decision.justification), '') IS NULL
       )
       OR (
         decision.verdict IN ('admite_erro', 'equivalente')
         AND NULLIF(btrim(decision.justification), '') IS NOT NULL
       )
  ) THEN
    RAISE EXCEPTION 'invalid self review verdict or justification'
      USING ERRCODE = '23514';
  END IF;

  PERFORM field_review.id
  FROM public.field_reviews AS field_review
  JOIN jsonb_to_recordset(p_decisions) AS decision(
    "fieldReviewId" uuid, verdict text, justification text
  ) ON decision."fieldReviewId" = field_review.id
  WHERE field_review.project_id = p_project_id
    AND field_review.document_id = p_document_id
    AND field_review.self_reviewer_id = actor_id
  ORDER BY field_review.id
  FOR UPDATE OF field_review;

  IF (
    SELECT count(*)
    FROM public.field_reviews AS field_review
    JOIN jsonb_to_recordset(p_decisions) AS decision(
      "fieldReviewId" uuid, verdict text, justification text
    ) ON decision."fieldReviewId" = field_review.id
    WHERE field_review.project_id = p_project_id
      AND field_review.document_id = p_document_id
      AND field_review.self_reviewer_id = actor_id
  ) IS DISTINCT FROM jsonb_array_length(p_decisions) THEN
    RAISE EXCEPTION 'field review row not found or owned by another reviewer'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.field_reviews AS field_review
    JOIN jsonb_to_recordset(p_decisions) AS decision(
      "fieldReviewId" uuid, verdict text, justification text
    ) ON decision."fieldReviewId" = field_review.id
    WHERE field_review.self_verdict IS NOT NULL
      AND (
        field_review.self_verdict IS DISTINCT FROM decision.verdict
        OR field_review.self_justification IS DISTINCT FROM
           CASE
             WHEN decision.verdict IN ('contesta_llm', 'ambiguo')
               THEN NULLIF(btrim(decision.justification), '')
             ELSE NULL
           END
      )
  ) THEN
    RAISE EXCEPTION 'self review was already submitted with different values'
      USING ERRCODE = '23514';
  END IF;

  WITH decisions AS (
    SELECT "fieldReviewId" AS id,
           verdict,
           CASE
             WHEN verdict IN ('contesta_llm', 'ambiguo')
               THEN NULLIF(btrim(justification), '')
             ELSE NULL
           END AS justification
    FROM jsonb_to_recordset(p_decisions) AS decision(
      "fieldReviewId" uuid, verdict text, justification text
    )
  ), updated AS (
    UPDATE public.field_reviews AS field_review
    SET self_verdict = decision.verdict,
        self_reviewed_at = transaction_timestamp(),
        self_justification = decision.justification
    FROM decisions AS decision
    WHERE field_review.id = decision.id
      AND field_review.self_verdict IS NULL
    RETURNING field_review.id
  )
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[])
  INTO updated_ids
  FROM updated;

  INSERT INTO public.response_equivalences (
    project_id, document_id, field_name,
    response_a_id, response_b_id, reviewer_id
  )
  SELECT field_review.project_id,
         field_review.document_id,
         field_review.field_name,
         LEAST(field_review.human_response_id, field_review.llm_response_id),
         GREATEST(field_review.human_response_id, field_review.llm_response_id),
         actor_id
  FROM public.field_reviews AS field_review
  WHERE field_review.id = ANY(updated_ids)
    AND field_review.self_verdict = 'equivalente'
  ON CONFLICT (project_id, document_id, field_name, response_a_id, response_b_id)
    DO NOTHING;

  INSERT INTO public.project_comments (
    project_id, document_id, field_name, author_id, body, kind
  )
  SELECT field_review.project_id,
         field_review.document_id,
         field_review.field_name,
         actor_id,
         format(
           'Campo "%s" marcado como ambíguo na auto-revisão.%s%s%s%s',
           field_review.field_name,
           E'\n\nHumano respondeu: ',
           COALESCE(human_response.answers -> field_review.field_name, 'null'::jsonb)::text,
           E'\n\nLLM respondeu: ' ||
             COALESCE(llm_response.answers -> field_review.field_name, 'null'::jsonb)::text,
           E'\n\nJustificativa do pesquisador: ' || field_review.self_justification
         ),
         'note'
  FROM public.field_reviews AS field_review
  JOIN public.responses AS human_response ON human_response.id = field_review.human_response_id
  JOIN public.responses AS llm_response ON llm_response.id = field_review.llm_response_id
  WHERE field_review.id = ANY(updated_ids)
    AND field_review.self_verdict = 'ambiguo';

  UPDATE public.assignments AS assignment
  SET status = 'concluido', completed_at = transaction_timestamp()
  WHERE assignment.project_id = p_project_id
    AND assignment.document_id = p_document_id
    AND assignment.user_id = actor_id
    AND assignment.type = 'auto_revisao'
    AND NOT EXISTS (
      SELECT 1
      FROM public.field_reviews AS pending
      WHERE pending.project_id = p_project_id
        AND pending.document_id = p_document_id
        AND pending.self_reviewer_id = actor_id
        AND pending.self_verdict IS NULL
    );

  SELECT COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'fieldReviewId', field_review.id,
               'fieldName', field_review.field_name
             )
             ORDER BY field_review.id
           ),
           '[]'::jsonb
         )
  INTO needs_arbitrator
  FROM public.field_reviews AS field_review
  JOIN jsonb_to_recordset(p_decisions) AS decision(
    "fieldReviewId" uuid, verdict text, justification text
  ) ON decision."fieldReviewId" = field_review.id
  WHERE field_review.self_verdict = 'contesta_llm'
    AND field_review.arbitrator_id IS NULL;

  RETURN jsonb_build_object(
    'updatedCount', cardinality(updated_ids),
    'needsArbitrator', needs_arbitrator
  );
END;
$$;

DROP FUNCTION IF EXISTS public.submit_blind_arbitration(uuid, uuid, uuid, jsonb);
CREATE FUNCTION public.submit_blind_arbitration(
  p_project_id uuid,
  p_document_id uuid,
  p_decisions jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := public.auth_user_effective_member_id(p_project_id);
  updated_count integer;
BEGIN
  IF public.clerk_uid() IS NULL OR p_project_id IS NULL
     OR (
       NOT public.is_master()
       AND p_project_id NOT IN (
         SELECT public.auth_user_accessible_project_ids()
       )
     )
     OR actor_id IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM public.project_members AS member
       WHERE member.project_id = p_project_id
         AND member.user_id = actor_id
         AND member.can_arbitrate
     ) THEN
    RAISE EXCEPTION 'eligible authenticated arbitrator required'
      USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_decisions) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_decisions) = 0 THEN
    RAISE EXCEPTION 'p_decisions must be a non-empty JSON array'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_decisions) AS item(value)
    WHERE jsonb_typeof(value) IS DISTINCT FROM 'object'
       OR (value - ARRAY['fieldReviewId', 'verdict']::text[])
          IS DISTINCT FROM '{}'::jsonb
       OR NOT (value ?& ARRAY['fieldReviewId', 'verdict']::text[])
  ) OR EXISTS (
    SELECT "fieldReviewId"
    FROM jsonb_to_recordset(p_decisions) AS decision("fieldReviewId" uuid, verdict text)
    GROUP BY "fieldReviewId"
    HAVING "fieldReviewId" IS NULL OR count(*) > 1
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_decisions) AS decision("fieldReviewId" uuid, verdict text)
    WHERE verdict NOT IN ('humano', 'llm')
  ) THEN
    RAISE EXCEPTION 'blind arbitration decision is invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM field_review.id
  FROM public.field_reviews AS field_review
  JOIN jsonb_to_recordset(p_decisions) AS decision("fieldReviewId" uuid, verdict text)
    ON decision."fieldReviewId" = field_review.id
  WHERE field_review.project_id = p_project_id
    AND field_review.document_id = p_document_id
    AND field_review.arbitrator_id = actor_id
  ORDER BY field_review.id
  FOR UPDATE OF field_review;

  IF (
    SELECT count(*)
    FROM public.field_reviews AS field_review
    JOIN jsonb_to_recordset(p_decisions) AS decision("fieldReviewId" uuid, verdict text)
      ON decision."fieldReviewId" = field_review.id
    WHERE field_review.project_id = p_project_id
      AND field_review.document_id = p_document_id
      AND field_review.arbitrator_id = actor_id
      AND field_review.self_verdict = 'contesta_llm'
  ) IS DISTINCT FROM jsonb_array_length(p_decisions) THEN
    RAISE EXCEPTION 'blind arbitration row is missing, unassigned, or not contested'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.field_reviews AS field_review
    JOIN jsonb_to_recordset(p_decisions) AS decision("fieldReviewId" uuid, verdict text)
      ON decision."fieldReviewId" = field_review.id
    WHERE field_review.blind_verdict IS NOT NULL
      AND field_review.blind_verdict IS DISTINCT FROM decision.verdict
  ) THEN
    RAISE EXCEPTION 'blind arbitration was already submitted with a different verdict'
      USING ERRCODE = '23514';
  END IF;

  WITH decisions AS (
    SELECT "fieldReviewId" AS id, verdict
    FROM jsonb_to_recordset(p_decisions) AS decision("fieldReviewId" uuid, verdict text)
  ), updated AS (
    UPDATE public.field_reviews AS field_review
    SET blind_verdict = decision.verdict,
        blind_decided_at = transaction_timestamp()
    FROM decisions AS decision
    WHERE field_review.id = decision.id
      AND field_review.blind_verdict IS NULL
    RETURNING field_review.id
  )
  SELECT count(*)::integer INTO updated_count FROM updated;

  RETURN jsonb_build_object('updatedCount', updated_count);
END;
$$;

DROP FUNCTION IF EXISTS public.submit_final_arbitration(uuid, uuid, uuid, jsonb);
CREATE FUNCTION public.submit_final_arbitration(
  p_project_id uuid,
  p_document_id uuid,
  p_decisions jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid uuid := public.clerk_uid();
  actor_id uuid := public.auth_user_effective_member_id(p_project_id);
  updated_ids uuid[] := ARRAY[]::uuid[];
  assignment_completed boolean := false;
BEGIN
  IF uid IS NULL OR p_project_id IS NULL
     OR (
       NOT public.is_master()
       AND p_project_id NOT IN (
         SELECT public.auth_user_accessible_project_ids()
       )
     )
     OR actor_id IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM public.project_members AS member
       WHERE member.project_id = p_project_id
         AND member.user_id = actor_id
         AND member.can_arbitrate
     ) THEN
    RAISE EXCEPTION 'eligible authenticated arbitrator required'
      USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_decisions) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_decisions) = 0 THEN
    RAISE EXCEPTION 'p_decisions must be a non-empty JSON array'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_decisions) AS item(value)
    WHERE jsonb_typeof(value) IS DISTINCT FROM 'object'
       OR (value - ARRAY[
             'fieldReviewId', 'verdict', 'questionImprovementSuggestion',
             'arbitratorComment'
           ]::text[]) IS DISTINCT FROM '{}'::jsonb
       OR NOT (value ?& ARRAY['fieldReviewId', 'verdict']::text[])
  ) OR EXISTS (
    SELECT "fieldReviewId"
    FROM jsonb_to_recordset(p_decisions) AS decision(
      "fieldReviewId" uuid,
      verdict text,
      "questionImprovementSuggestion" text,
      "arbitratorComment" text
    )
    GROUP BY "fieldReviewId"
    HAVING "fieldReviewId" IS NULL OR count(*) > 1
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_decisions) AS decision(
      "fieldReviewId" uuid,
      verdict text,
      "questionImprovementSuggestion" text,
      "arbitratorComment" text
    )
    WHERE verdict NOT IN ('humano', 'llm')
       OR (
         verdict = 'llm'
         AND NULLIF(btrim("questionImprovementSuggestion"), '') IS NULL
       )
       OR (
         verdict = 'humano'
         AND NULLIF(btrim("questionImprovementSuggestion"), '') IS NOT NULL
       )
  ) THEN
    RAISE EXCEPTION 'final arbitration decision is invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM field_review.id
  FROM public.field_reviews AS field_review
  JOIN jsonb_to_recordset(p_decisions) AS decision(
    "fieldReviewId" uuid,
    verdict text,
    "questionImprovementSuggestion" text,
    "arbitratorComment" text
  ) ON decision."fieldReviewId" = field_review.id
  WHERE field_review.project_id = p_project_id
    AND field_review.document_id = p_document_id
    AND field_review.arbitrator_id = actor_id
  ORDER BY field_review.id
  FOR UPDATE OF field_review;

  IF (
    SELECT count(*)
    FROM public.field_reviews AS field_review
    JOIN jsonb_to_recordset(p_decisions) AS decision(
      "fieldReviewId" uuid,
      verdict text,
      "questionImprovementSuggestion" text,
      "arbitratorComment" text
    ) ON decision."fieldReviewId" = field_review.id
    WHERE field_review.project_id = p_project_id
      AND field_review.document_id = p_document_id
      AND field_review.arbitrator_id = actor_id
      AND field_review.self_verdict = 'contesta_llm'
      AND field_review.blind_verdict IS NOT NULL
  ) IS DISTINCT FROM jsonb_array_length(p_decisions) THEN
    RAISE EXCEPTION 'final arbitration requires assigned rows with a blind decision'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.field_reviews AS field_review
    JOIN jsonb_to_recordset(p_decisions) AS decision(
      "fieldReviewId" uuid,
      verdict text,
      "questionImprovementSuggestion" text,
      "arbitratorComment" text
    ) ON decision."fieldReviewId" = field_review.id
    WHERE field_review.final_verdict IS NOT NULL
      AND (
        field_review.final_verdict IS DISTINCT FROM decision.verdict
        OR field_review.question_improvement_suggestion IS DISTINCT FROM
           CASE
             WHEN decision.verdict = 'llm'
               THEN NULLIF(btrim(decision."questionImprovementSuggestion"), '')
             ELSE NULL
           END
        OR field_review.arbitrator_comment IS DISTINCT FROM
           NULLIF(btrim(decision."arbitratorComment"), '')
      )
  ) THEN
    RAISE EXCEPTION 'final arbitration was already submitted with different values'
      USING ERRCODE = '23514';
  END IF;

  WITH decisions AS (
    SELECT "fieldReviewId" AS id,
           verdict,
           CASE
             WHEN verdict = 'llm'
               THEN NULLIF(btrim("questionImprovementSuggestion"), '')
             ELSE NULL
           END AS suggestion,
           NULLIF(btrim("arbitratorComment"), '') AS comment
    FROM jsonb_to_recordset(p_decisions) AS decision(
      "fieldReviewId" uuid,
      verdict text,
      "questionImprovementSuggestion" text,
      "arbitratorComment" text
    )
  ), updated AS (
    UPDATE public.field_reviews AS field_review
    SET final_verdict = decision.verdict,
        final_decided_at = transaction_timestamp(),
        question_improvement_suggestion = decision.suggestion,
        arbitrator_comment = decision.comment
    FROM decisions AS decision
    WHERE field_review.id = decision.id
      AND field_review.final_verdict IS NULL
    RETURNING field_review.id
  )
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[])
  INTO updated_ids
  FROM updated;

  INSERT INTO public.project_comments (
    project_id, document_id, field_name, author_id, body, kind
  )
  SELECT field_review.project_id,
         field_review.document_id,
         field_review.field_name,
         actor_id,
         format(
           'Discordância em "%s".%s%s%s%s%s%s',
           field_review.field_name,
           E'\n\nHumano respondeu: ',
           COALESCE(human_response.answers -> field_review.field_name, 'null'::jsonb)::text,
           E'\n\nLLM respondeu: ',
           COALESCE(llm_response.answers -> field_review.field_name, 'null'::jsonb)::text,
           E'\n\nÁrbitro manteve LLM.\n\nSugestão de melhoria: ' ||
             field_review.question_improvement_suggestion,
           CASE
             WHEN field_review.arbitrator_comment IS NULL THEN ''
             ELSE E'\n\nComentário: ' || field_review.arbitrator_comment
           END
         ),
         'note'
  FROM public.field_reviews AS field_review
  JOIN public.responses AS human_response ON human_response.id = field_review.human_response_id
  JOIN public.responses AS llm_response ON llm_response.id = field_review.llm_response_id
  WHERE field_review.id = ANY(updated_ids)
    AND field_review.final_verdict = 'llm';

  IF NOT EXISTS (
    SELECT 1
    FROM public.field_reviews AS pending
    WHERE pending.project_id = p_project_id
      AND pending.document_id = p_document_id
      AND pending.arbitrator_id = actor_id
      AND pending.self_verdict = 'contesta_llm'
      AND pending.final_verdict IS NULL
  ) THEN
    UPDATE public.assignments AS assignment
    SET status = 'concluido', completed_at = transaction_timestamp()
    WHERE assignment.project_id = p_project_id
      AND assignment.document_id = p_document_id
      AND assignment.user_id = actor_id
      AND assignment.type = 'arbitragem';
    assignment_completed := FOUND;
  END IF;

  RETURN jsonb_build_object(
    'updatedCount', cardinality(updated_ids),
    'assignmentCompleted', assignment_completed
  );
END;
$$;

-- A unificação torna explícitas autoridade, locks, colisões irrecuperáveis e
-- liberação das filas que o target não está habilitado a assumir.
CREATE OR REPLACE FUNCTION public.unify_project_members(
  p_project_id uuid,
  p_source_user_id uuid,
  p_target_user_id uuid,
  p_acting_user_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_acting_effective_user_id uuid;
  v_target_can_arbitrate boolean;
  v_target_can_compare boolean;
  v_released_documents uuid[];
  v_source_email text;
  v_alias_id uuid;
BEGIN
  IF p_source_user_id IS NULL
     OR p_target_user_id IS NULL
     OR p_source_user_id = p_target_user_id THEN
    RAISE EXCEPTION 'source e target devem ser membros distintos'
      USING ERRCODE = '22023';
  END IF;

  -- Todas as transações que alteram a partição alias/membership adquirem o
  -- projeto antes das linhas de membership. O trigger usa a mesma ordem.
  PERFORM project.id
  FROM public.projects AS project
  WHERE project.id = p_project_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'project not found' USING ERRCODE = '23503';
  END IF;

  SELECT link.member_user_id
  INTO v_acting_effective_user_id
  FROM public.member_email_links AS link
  WHERE link.project_id = p_project_id
    AND link.linked_user_id = p_acting_user_id;
  v_acting_effective_user_id := COALESCE(
    v_acting_effective_user_id,
    p_acting_user_id
  );

  IF p_acting_user_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.projects AS project
    WHERE project.id = p_project_id
      AND (
        project.created_by = v_acting_effective_user_id
        OR EXISTS (
          SELECT 1
          FROM public.project_members AS actor
          WHERE actor.project_id = project.id
            AND actor.user_id = v_acting_effective_user_id
            AND actor.role = 'coordenador'
        )
        OR EXISTS (
          SELECT 1
          FROM public.master_users AS master
          WHERE master.user_id = p_acting_user_id
        )
      )
  ) THEN
    RAISE EXCEPTION 'acting user cannot unify members in this project'
      USING ERRCODE = '42501';
  END IF;

  -- A ordem UUID é compartilhada por chamadas concorrentes com o mesmo par.
  PERFORM member.id
  FROM public.project_members AS member
  WHERE member.project_id = p_project_id
    AND member.user_id IN (p_source_user_id, p_target_user_id)
  ORDER BY member.user_id
  FOR UPDATE;

  SELECT target.can_arbitrate, target.can_compare
  INTO v_target_can_arbitrate, v_target_can_compare
  FROM public.project_members AS target
  WHERE target.project_id = p_project_id
    AND target.user_id = p_target_user_id;

  IF NOT FOUND OR NOT EXISTS (
    SELECT 1
    FROM public.project_members AS source
    WHERE source.project_id = p_project_id
      AND source.user_id = p_source_user_id
  ) THEN
    RAISE EXCEPTION 'source e target devem ser membros do projeto'
      USING ERRCODE = '23503';
  END IF;

  -- Uma decisão final não pode perder a distinção entre auto-revisor e
  -- árbitro. Como ambos são históricos, escolher arbitrariamente qual manter
  -- falsificaria autoria; a unificação falha fechada e sem efeito parcial.
  IF EXISTS (
    SELECT 1
    FROM public.field_reviews AS field_review
    WHERE field_review.project_id = p_project_id
      AND field_review.final_verdict IS NOT NULL
      AND (
        (field_review.self_reviewer_id = p_source_user_id
         AND field_review.arbitrator_id = p_target_user_id)
        OR
        (field_review.self_reviewer_id = p_target_user_id
         AND field_review.arbitrator_id = p_source_user_id)
      )
  ) THEN
    RAISE EXCEPTION 'member unification would collapse finalized reviewer identities'
      USING ERRCODE = '23514';
  END IF;

  -- Trabalho aberto pode voltar à fila sem falsificar histórico. Também é
  -- liberado quando o target não tem permissão para assumir a arbitragem.
  WITH released AS (
    UPDATE public.field_reviews AS field_review
    SET arbitrator_id = NULL,
        blind_verdict = NULL,
        blind_decided_at = NULL
    WHERE field_review.project_id = p_project_id
      AND field_review.final_verdict IS NULL
      AND field_review.arbitrator_id IS NOT NULL
      AND (
        (field_review.arbitrator_id = p_source_user_id
         AND NOT v_target_can_arbitrate)
        OR
        (field_review.self_reviewer_id = p_source_user_id
         AND field_review.arbitrator_id = p_target_user_id)
        OR
        (field_review.self_reviewer_id = p_target_user_id
         AND field_review.arbitrator_id = p_source_user_id)
      )
    RETURNING field_review.document_id
  )
  SELECT array_agg(DISTINCT released.document_id)
  INTO v_released_documents
  FROM released;

  IF v_released_documents IS NOT NULL THEN
    DELETE FROM public.assignments AS assignment
    WHERE assignment.project_id = p_project_id
      AND assignment.document_id = ANY(v_released_documents)
      AND assignment.user_id IN (p_source_user_id, p_target_user_id)
      AND assignment.type = 'arbitragem'
      AND assignment.status <> 'concluido'
      AND NOT EXISTS (
        SELECT 1
        FROM public.field_reviews AS pending
        WHERE pending.project_id = assignment.project_id
          AND pending.document_id = assignment.document_id
          AND pending.arbitrator_id = assignment.user_id
          AND pending.final_verdict IS NULL
      );
  END IF;

  IF NOT v_target_can_compare THEN
    DELETE FROM public.assignments AS assignment
    WHERE assignment.project_id = p_project_id
      AND assignment.user_id = p_source_user_id
      AND assignment.type = 'comparacao'
      AND assignment.status <> 'concluido';
  END IF;

  -- Colisões preservam a linha do target. O status é reconciliado abaixo caso
  -- essa linha concluída passe a representar trabalho ainda aberto.
  DELETE FROM public.assignments AS source
  WHERE source.project_id = p_project_id
    AND source.user_id = p_source_user_id
    AND EXISTS (
      SELECT 1
      FROM public.assignments AS target
      WHERE target.project_id = p_project_id
        AND target.user_id = p_target_user_id
        AND target.document_id = source.document_id
        AND target.type = source.type
    );
  UPDATE public.assignments
  SET user_id = p_target_user_id
  WHERE project_id = p_project_id AND user_id = p_source_user_id;

  UPDATE public.responses
  SET respondent_id = p_target_user_id
  WHERE project_id = p_project_id AND respondent_id = p_source_user_id;

  WITH ranked AS (
    SELECT id,
           row_number() OVER (
             PARTITION BY document_id
             ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
           ) AS position
    FROM public.responses
    WHERE project_id = p_project_id
      AND respondent_id = p_target_user_id
      AND respondent_type = 'humano'
      AND is_latest
  )
  UPDATE public.responses AS response
  SET is_latest = false
  FROM ranked
  WHERE response.id = ranked.id AND ranked.position > 1;

  DELETE FROM public.reviews AS source
  WHERE source.project_id = p_project_id
    AND source.reviewer_id = p_source_user_id
    AND EXISTS (
      SELECT 1
      FROM public.reviews AS target
      WHERE target.project_id = p_project_id
        AND target.reviewer_id = p_target_user_id
        AND target.document_id = source.document_id
        AND target.field_name = source.field_name
    );
  UPDATE public.reviews
  SET reviewer_id = p_target_user_id
  WHERE project_id = p_project_id AND reviewer_id = p_source_user_id;
  UPDATE public.reviews
  SET resolved_by = p_target_user_id
  WHERE project_id = p_project_id AND resolved_by = p_source_user_id;

  DELETE FROM public.verdict_acknowledgments AS source
  WHERE source.respondent_id = p_source_user_id
    AND source.review_id IN (
      SELECT review.id FROM public.reviews AS review
      WHERE review.project_id = p_project_id
    )
    AND EXISTS (
      SELECT 1
      FROM public.verdict_acknowledgments AS target
      WHERE target.review_id = source.review_id
        AND target.respondent_id = p_target_user_id
    );
  UPDATE public.verdict_acknowledgments AS acknowledgment
  SET respondent_id = p_target_user_id
  WHERE acknowledgment.respondent_id = p_source_user_id
    AND acknowledgment.review_id IN (
      SELECT review.id FROM public.reviews AS review
      WHERE review.project_id = p_project_id
    );
  UPDATE public.verdict_acknowledgments AS acknowledgment
  SET resolved_by = p_target_user_id
  WHERE acknowledgment.resolved_by = p_source_user_id
    AND acknowledgment.review_id IN (
      SELECT review.id FROM public.reviews AS review
      WHERE review.project_id = p_project_id
    );

  UPDATE public.field_reviews
  SET self_reviewer_id = p_target_user_id
  WHERE project_id = p_project_id AND self_reviewer_id = p_source_user_id;
  UPDATE public.field_reviews
  SET arbitrator_id = p_target_user_id
  WHERE project_id = p_project_id AND arbitrator_id = p_source_user_id;

  UPDATE public.project_comments
  SET author_id = p_target_user_id
  WHERE project_id = p_project_id AND author_id = p_source_user_id;
  UPDATE public.project_comments
  SET resolved_by = p_target_user_id
  WHERE project_id = p_project_id AND resolved_by = p_source_user_id;

  UPDATE public.difficulty_resolutions
  SET resolved_by = p_target_user_id
  WHERE project_id = p_project_id AND resolved_by = p_source_user_id;
  UPDATE public.error_resolutions
  SET resolved_by = p_target_user_id
  WHERE project_id = p_project_id AND resolved_by = p_source_user_id;
  UPDATE public.note_resolutions
  SET resolved_by = p_target_user_id
  WHERE project_id = p_project_id AND resolved_by = p_source_user_id;

  UPDATE public.documents
  SET excluded_by = p_target_user_id
  WHERE project_id = p_project_id AND excluded_by = p_source_user_id;

  UPDATE public.schema_suggestions
  SET suggested_by = p_target_user_id
  WHERE project_id = p_project_id AND suggested_by = p_source_user_id;
  UPDATE public.schema_suggestions
  SET resolved_by = p_target_user_id
  WHERE project_id = p_project_id AND resolved_by = p_source_user_id;

  UPDATE public.schema_change_log
  SET changed_by = p_target_user_id
  WHERE project_id = p_project_id AND changed_by = p_source_user_id;

  UPDATE public.response_equivalences
  SET reviewer_id = p_target_user_id
  WHERE project_id = p_project_id AND reviewer_id = p_source_user_id;

  UPDATE public.assignment_batches
  SET created_by = p_target_user_id
  WHERE project_id = p_project_id AND created_by = p_source_user_id;

  DELETE FROM public.researcher_field_orders
  WHERE project_id = p_project_id AND user_id = p_source_user_id;

  UPDATE public.member_email_links
  SET member_user_id = p_target_user_id
  WHERE project_id = p_project_id AND member_user_id = p_source_user_id;
  DELETE FROM public.member_email_links
  WHERE project_id = p_project_id AND member_user_id = linked_user_id;

  SELECT profile.email INTO v_source_email
  FROM public.profiles AS profile
  WHERE profile.id = p_source_user_id;
  IF v_source_email IS NULL THEN
    RAISE EXCEPTION 'source member requires an email before unification'
      USING ERRCODE = '23514';
  END IF;

  -- O source deixa de ser membership antes de virar alias. O trigger da
  -- partição canônica impede que uma identidade ocupe os dois papéis.
  DELETE FROM public.project_members
  WHERE project_id = p_project_id AND user_id = p_source_user_id;

  SELECT link.id
  INTO v_alias_id
  FROM public.member_email_links AS link
  WHERE link.project_id = p_project_id
    AND link.email = lower(v_source_email)
  FOR UPDATE;

  IF FOUND THEN
    UPDATE public.member_email_links AS link
    SET linked_user_id = p_source_user_id
    WHERE link.id = v_alias_id
      AND link.member_user_id = p_target_user_id
      AND (
        link.linked_user_id IS NULL
        OR link.linked_user_id = p_source_user_id
      );
    IF NOT FOUND THEN
      RAISE EXCEPTION 'source email is linked to an incompatible project identity'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    INSERT INTO public.member_email_links (
      project_id, member_user_id, email, linked_user_id, created_by
    ) VALUES (
      p_project_id, p_target_user_id, lower(v_source_email),
      p_source_user_id, p_acting_user_id
    )
    RETURNING id INTO v_alias_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.member_email_links AS link
    WHERE link.id = v_alias_id
      AND link.project_id = p_project_id
      AND link.member_user_id = p_target_user_id
      AND link.linked_user_id = p_source_user_id
  ) THEN
    RAISE EXCEPTION 'member unification did not create the canonical alias'
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.projects
  SET created_by = p_target_user_id
  WHERE id = p_project_id AND created_by = p_source_user_id;

  -- Se o core resolveu uma colisão de assignments a favor de uma linha já
  -- concluída do target, trabalho recém-migrado não pode ficar invisível atrás
  -- desse status histórico.
  UPDATE public.assignments AS assignment
  SET status = 'pendente', completed_at = NULL
  WHERE assignment.project_id = p_project_id
    AND assignment.user_id = p_target_user_id
    AND (
      (
        assignment.type = 'auto_revisao'
        AND EXISTS (
          SELECT 1
          FROM public.field_reviews AS pending
          WHERE pending.project_id = assignment.project_id
            AND pending.document_id = assignment.document_id
            AND pending.self_reviewer_id = assignment.user_id
            AND pending.self_verdict IS NULL
        )
      )
      OR
      (
        assignment.type = 'arbitragem'
        AND EXISTS (
          SELECT 1
          FROM public.field_reviews AS pending
          WHERE pending.project_id = assignment.project_id
            AND pending.document_id = assignment.document_id
            AND pending.arbitrator_id = assignment.user_id
            AND pending.final_verdict IS NULL
        )
      )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.unify_project_members(uuid, uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unify_project_members(uuid, uuid, uuid, uuid)
  TO service_role;

-- A RPC de permissão criada na migration anterior também libera reviews e
-- assignments. Depois que UPDATE genérico em field_reviews deixa de existir,
-- ela precisa carregar sua própria autorização em vez de depender daquela
-- policy ampla.
CREATE OR REPLACE FUNCTION public.set_member_arbitration_permission(
  p_member_id uuid,
  p_enabled boolean
) RETURNS TABLE(project_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid uuid := public.clerk_uid();
  v_project_id uuid;
  v_user_id uuid;
  v_document_ids uuid[];
BEGIN
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'arbitration permission is required' USING ERRCODE = '22023';
  END IF;

  SELECT member.project_id, member.user_id
  INTO v_project_id, v_user_id
  FROM public.project_members AS member
  WHERE member.id = p_member_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF uid IS NULL OR (
    NOT public.is_master()
    AND v_project_id NOT IN (
      SELECT public.auth_user_coordinator_or_creator_project_ids()
    )
  ) THEN
    RETURN;
  END IF;

  UPDATE public.project_members AS member
  SET can_arbitrate = p_enabled
  WHERE member.id = p_member_id;

  IF NOT p_enabled THEN
    WITH released_reviews AS (
      UPDATE public.field_reviews AS field_review
      SET arbitrator_id = NULL,
          blind_verdict = NULL,
          blind_decided_at = NULL
      WHERE field_review.project_id = v_project_id
        AND field_review.arbitrator_id = v_user_id
        AND field_review.self_verdict = 'contesta_llm'
        AND field_review.final_verdict IS NULL
      RETURNING field_review.document_id
    )
    SELECT array_agg(DISTINCT released.document_id)
    INTO v_document_ids
    FROM released_reviews AS released;

    IF v_document_ids IS NOT NULL THEN
      DELETE FROM public.assignments AS assignment
      WHERE assignment.project_id = v_project_id
        AND assignment.user_id = v_user_id
        AND assignment.document_id = ANY(v_document_ids)
        AND assignment.type = 'arbitragem'
        AND assignment.status <> 'concluido';
    END IF;
  END IF;

  RETURN QUERY SELECT v_project_id;
END;
$$;

-- A permissão de comparação segue o mesmo contrato: a flag e a liberação de
-- assignments pendentes são uma única mutação definer, sem UPDATE genérico na
-- tabela de membros.
CREATE OR REPLACE FUNCTION public.set_member_comparison_permission(
  p_member_id uuid,
  p_enabled boolean
) RETURNS TABLE(project_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid uuid := public.clerk_uid();
  v_project_id uuid;
  v_user_id uuid;
BEGIN
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'comparison permission is required' USING ERRCODE = '22023';
  END IF;

  SELECT member.project_id, member.user_id
  INTO v_project_id, v_user_id
  FROM public.project_members AS member
  WHERE member.id = p_member_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF uid IS NULL OR (
    NOT public.is_master()
    AND v_project_id NOT IN (
      SELECT public.auth_user_coordinator_or_creator_project_ids()
    )
  ) THEN
    RETURN;
  END IF;

  UPDATE public.project_members AS member
  SET can_compare = p_enabled
  WHERE member.id = p_member_id;

  IF NOT p_enabled THEN
    DELETE FROM public.assignments AS assignment
    WHERE assignment.project_id = v_project_id
      AND assignment.user_id = v_user_id
      AND assignment.type = 'comparacao'
      AND assignment.status = 'pendente';
  END IF;

  RETURN QUERY SELECT v_project_id;
END;
$$;

-- Remover membership também precisa tornar os trabalhos pendentes novamente
-- atribuíveis. Linhas já decididas permanecem como histórico; linhas de
-- auto-revisão ainda vazias não têm ator possível e são removidas com a fila.
CREATE OR REPLACE FUNCTION public.remove_project_member(
  p_member_id uuid
) RETURNS TABLE(project_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid uuid := public.clerk_uid();
  v_project_id uuid;
  v_user_id uuid;
BEGIN
  SELECT member.project_id, member.user_id
  INTO v_project_id, v_user_id
  FROM public.project_members AS member
  WHERE member.id = p_member_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF uid IS NULL OR (
    NOT public.is_master()
    AND v_project_id NOT IN (
      SELECT public.auth_user_coordinator_or_creator_project_ids()
    )
  ) THEN
    RETURN;
  END IF;

  UPDATE public.field_reviews AS field_review
  SET arbitrator_id = NULL,
      blind_verdict = NULL,
      blind_decided_at = NULL
  WHERE field_review.project_id = v_project_id
    AND field_review.arbitrator_id = v_user_id
    AND field_review.final_verdict IS NULL;

  DELETE FROM public.field_reviews AS field_review
  WHERE field_review.project_id = v_project_id
    AND field_review.self_reviewer_id = v_user_id
    AND field_review.self_verdict IS NULL;

  DELETE FROM public.assignments AS assignment
  WHERE assignment.project_id = v_project_id
    AND assignment.user_id = v_user_id
    AND assignment.status <> 'concluido';

  DELETE FROM public.member_email_links AS link
  WHERE link.project_id = v_project_id
    AND link.member_user_id = v_user_id;

  DELETE FROM public.project_members AS member
  WHERE member.id = p_member_id;

  RETURN QUERY SELECT v_project_id;
END;
$$;

-- O recálculo do backlog parte de leituras feitas pela sessão autenticada, mas
-- a reconciliação precisa inserir field_reviews que pertencem a outros
-- pesquisadores. Concentrar as mutações nesta RPC evita uma janela entre o
-- gate da action e escritas service-role: o papel autorizador fica bloqueado e
-- é revalidado na mesma transação que apaga, insere e remove órfãos.
CREATE OR REPLACE FUNCTION public.reconcile_auto_review_backlog(
  p_project_id uuid,
  p_actor_id uuid,
  p_field_review_rows jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid;
  creator_id uuid;
  authorized boolean := false;
  removed_count integer := 0;
  kept_resolved integer := 0;
BEGIN
  IF p_actor_id IS NULL OR p_project_id IS NULL THEN
    RAISE EXCEPTION 'project actor required'
      USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(COALESCE(p_field_review_rows, 'null'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'field review rows must be an array'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_field_review_rows) AS items(item)
    WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR (item - ARRAY[
            'document_id', 'field_name', 'human_response_id',
            'llm_response_id', 'self_reviewer_id'
          ]::text[]) IS DISTINCT FROM '{}'::jsonb
  ) THEN
    RAISE EXCEPTION 'field review rows must contain only canonical keys'
      USING ERRCODE = '22023';
  END IF;

  -- A ordem project -> membership/master é a mesma das demais mutações de
  -- identidade desta migration. FOR SHARE mantém a autorização estável até o
  -- commit, inclusive contra UPDATE de role (que FOR KEY SHARE permitiria).
  SELECT project.created_by
  INTO creator_id
  FROM public.projects AS project
  WHERE project.id = p_project_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'project not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT link.member_user_id
  INTO actor_id
  FROM public.member_email_links AS link
  WHERE link.project_id = p_project_id
    AND link.linked_user_id = p_actor_id
  FOR SHARE;
  actor_id := COALESCE(actor_id, p_actor_id);

  authorized := creator_id = actor_id;

  IF NOT authorized THEN
    SELECT true
    INTO authorized
    FROM public.project_members AS member
    WHERE member.project_id = p_project_id
      AND member.user_id = actor_id
      AND member.role = 'coordenador'
    FOR SHARE;
  END IF;

  IF NOT COALESCE(authorized, false) THEN
    SELECT true
    INTO authorized
    FROM public.master_users AS master
    WHERE master.user_id = p_actor_id
    FOR SHARE;
  END IF;

  IF NOT COALESCE(authorized, false) THEN
    RAISE EXCEPTION 'coordinator, creator, or master required'
      USING ERRCODE = '42501';
  END IF;

  -- Impede remoção concorrente das memberships usadas pelo lote. O lock da
  -- autorização acima e estes locks seguem a ordem project -> memberships;
  -- a validação abaixo ocorre depois dos locks e rejeita qualquer ID ausente.
  PERFORM 1
  FROM public.project_members AS member
  WHERE member.project_id = p_project_id
    AND member.user_id IN (
      SELECT DISTINCT row.self_reviewer_id
      FROM jsonb_to_recordset(p_field_review_rows) AS row(
        self_reviewer_id uuid
      )
    )
  FOR SHARE;

  -- Completude/latest fazem parte do contrato desejado. Bloquear as responses
  -- antes de validá-las impede que essas flags mudem entre o preflight e o
  -- INSERT de field_reviews.
  PERFORM 1
  FROM public.responses AS response
  WHERE response.id IN (
    SELECT ids.response_id
    FROM jsonb_to_recordset(p_field_review_rows) AS row(
      human_response_id uuid,
      llm_response_id uuid
    )
    CROSS JOIN LATERAL unnest(ARRAY[
      row.human_response_id,
      row.llm_response_id
    ]) AS ids(response_id)
  )
  FOR SHARE;

  -- O payload vem exclusivamente da action server-side (a RPC é service-only),
  -- mas ainda é validado como lote indivisível para que bugs no caller não
  -- fabriquem estados parciais ou linhas que o algoritmo não poderia produzir.
  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_field_review_rows) AS row(
      document_id uuid,
      field_name text,
      human_response_id uuid,
      llm_response_id uuid,
      self_reviewer_id uuid
    )
    LEFT JOIN public.project_members AS member
      ON member.project_id = p_project_id
     AND member.user_id = row.self_reviewer_id
    LEFT JOIN public.responses AS human_response
      ON human_response.id = row.human_response_id
     AND human_response.project_id = p_project_id
     AND human_response.document_id = row.document_id
     AND human_response.respondent_type = 'humano'
     AND human_response.respondent_id = row.self_reviewer_id
     AND NOT human_response.is_partial
    LEFT JOIN public.responses AS llm_response
      ON llm_response.id = row.llm_response_id
     AND llm_response.project_id = p_project_id
     AND llm_response.document_id = row.document_id
     AND llm_response.respondent_type = 'llm'
     AND llm_response.is_latest
    WHERE row.document_id IS NULL
      OR NULLIF(row.field_name, '') IS NULL
      OR row.human_response_id IS NULL
      OR row.llm_response_id IS NULL
      OR row.self_reviewer_id IS NULL
      OR member.id IS NULL
      OR human_response.id IS NULL
      OR llm_response.id IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM public.projects AS project
        CROSS JOIN LATERAL jsonb_array_elements(project.pydantic_fields)
          AS fields(field)
        WHERE project.id = p_project_id
          AND field->>'name' = row.field_name
      )
  ) OR (
    SELECT count(*)
    FROM jsonb_to_recordset(p_field_review_rows) AS row(
      document_id uuid,
      field_name text
    )
  ) IS DISTINCT FROM (
    SELECT count(DISTINCT (row.document_id, row.field_name))
    FROM jsonb_to_recordset(p_field_review_rows) AS row(
      document_id uuid,
      field_name text
    )
  ) THEN
    RAISE EXCEPTION 'field review backlog contains invalid or duplicate rows'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*)::integer
  INTO kept_resolved
  FROM public.field_reviews AS field_review
  WHERE field_review.project_id = p_project_id
    AND field_review.self_verdict IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_field_review_rows) AS row(
        document_id uuid,
        field_name text
      )
      WHERE row.document_id = field_review.document_id
        AND row.field_name = field_review.field_name
    );

  DELETE FROM public.field_reviews AS field_review
  WHERE field_review.project_id = p_project_id
    AND field_review.self_verdict IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_field_review_rows) AS row(
        document_id uuid,
        field_name text
      )
      WHERE row.document_id = field_review.document_id
        AND row.field_name = field_review.field_name
    );
  GET DIAGNOSTICS removed_count = ROW_COUNT;

  INSERT INTO public.assignments (
    project_id,
    document_id,
    user_id,
    type,
    status
  )
  SELECT
    p_project_id,
    row.document_id,
    row.self_reviewer_id,
    'auto_revisao',
    'pendente'
  FROM jsonb_to_recordset(p_field_review_rows) AS row(
    document_id uuid,
    self_reviewer_id uuid
  )
  GROUP BY row.document_id, row.self_reviewer_id
  ON CONFLICT (document_id, user_id, type) DO NOTHING;

  INSERT INTO public.field_reviews (
    project_id,
    document_id,
    field_name,
    human_response_id,
    llm_response_id,
    self_reviewer_id
  )
  SELECT
    p_project_id,
    row.document_id,
    row.field_name,
    row.human_response_id,
    row.llm_response_id,
    row.self_reviewer_id
  FROM jsonb_to_recordset(p_field_review_rows) AS row(
    document_id uuid,
    field_name text,
    human_response_id uuid,
    llm_response_id uuid,
    self_reviewer_id uuid
  )
  ON CONFLICT (document_id, field_name) DO NOTHING;

  DELETE FROM public.assignments AS assignment
  WHERE assignment.project_id = p_project_id
    AND assignment.type = 'auto_revisao'
    AND assignment.status = 'pendente'
    AND NOT EXISTS (
      SELECT 1
      FROM public.field_reviews AS field_review
      WHERE field_review.project_id = p_project_id
        AND field_review.document_id = assignment.document_id
        AND field_review.self_reviewer_id = assignment.user_id
    );

  RETURN jsonb_build_object(
    'removedCount', removed_count,
    'keptResolved', kept_resolved
  );
END;
$$;

REVOKE ALL ON TYPE public.exclusion_request_decision FROM PUBLIC, anon, service_role;
GRANT USAGE ON TYPE public.exclusion_request_decision TO authenticated;

REVOKE ALL ON FUNCTION public.replace_and_add_documents(uuid, uuid[], boolean, jsonb, jsonb)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.request_document_exclusion(uuid, uuid, text)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.decide_exclusion_request(uuid, uuid, public.exclusion_request_decision, text)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.set_response_schema_versions(uuid, jsonb)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.submit_compare_review(uuid, uuid, text, text, uuid, text, uuid[], uuid[], boolean)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.mark_compare_doc_reviewed(uuid, uuid)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.add_response_equivalence(uuid, uuid, text, uuid, uuid)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.remove_response_equivalence(uuid, uuid)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.set_review_resolution(uuid, uuid, boolean)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.submit_self_review(uuid, uuid, jsonb)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.submit_blind_arbitration(uuid, uuid, jsonb)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.submit_final_arbitration(uuid, uuid, jsonb)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.set_member_arbitration_permission(uuid, boolean)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.set_member_comparison_permission(uuid, boolean)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.remove_project_member(uuid)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.reconcile_auto_review_backlog(uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.replace_and_add_documents(uuid, uuid[], boolean, jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_document_exclusion(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.decide_exclusion_request(uuid, uuid, public.exclusion_request_decision, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_response_schema_versions(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_compare_review(uuid, uuid, text, text, uuid, text, uuid[], uuid[], boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_compare_doc_reviewed(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_response_equivalence(uuid, uuid, text, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_response_equivalence(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_review_resolution(uuid, uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_self_review(uuid, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_blind_arbitration(uuid, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_final_arbitration(uuid, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_member_arbitration_permission(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_member_comparison_permission(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_project_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_auto_review_backlog(uuid, uuid, jsonb)
  TO service_role;

-- A policy administrativa ainda seleciona as linhas permitidas, mas os
-- privilégios de coluna impedem contornar as RPCs que liberam filas na mesma
-- transação. Papel e resolução não carregam backlog e seguem mutáveis direto.
REVOKE UPDATE, DELETE ON TABLE public.project_members FROM authenticated;
GRANT UPDATE (role, can_resolve) ON TABLE public.project_members TO authenticated;

-- Não há chamador no repositório e a função genérica permitia alterar JSON de
-- respostas fora do fluxo canônico de saveResponse.
DROP FUNCTION IF EXISTS public.remove_answer_key(uuid, text);
