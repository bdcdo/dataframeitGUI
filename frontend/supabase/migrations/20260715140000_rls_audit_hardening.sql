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

-- O bootstrap do Supabase concede privilégios de objetos public aos papéis da
-- API. A migration da view concedia authenticated/service_role, mas não
-- retirava o SELECT que anon já recebera pelo default grant.
REVOKE SELECT ON public.lottery_doc_stats FROM anon;

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
CREATE POLICY "Users manage own responses" ON public.responses FOR ALL
  USING (
    project_id IN (SELECT public.auth_user_accessible_project_ids())
    AND respondent_id IN (SELECT public.auth_user_member_identity_ids(project_id))
    AND respondent_type = 'humano'
  )
  WITH CHECK (
    project_id IN (SELECT public.auth_user_accessible_project_ids())
    AND respondent_id IN (SELECT public.auth_user_member_identity_ids(project_id))
    AND respondent_type = 'humano'
    AND EXISTS (
      SELECT 1
      FROM public.documents
      WHERE documents.id = responses.document_id
        AND documents.project_id = responses.project_id
    )
  );

DROP POLICY IF EXISTS "Reviewers manage reviews" ON public.reviews;
CREATE POLICY "Reviewers manage reviews" ON public.reviews FOR ALL
  USING (
    (
      project_id IN (SELECT public.auth_user_accessible_project_ids())
      AND reviewer_id IN (SELECT public.auth_user_member_identity_ids(project_id))
    )
    OR project_id IN (SELECT public.auth_user_coordinator_or_creator_project_ids())
    OR public.is_master()
  )
  WITH CHECK (
    (
      (
        project_id IN (SELECT public.auth_user_accessible_project_ids())
        AND reviewer_id IN (SELECT public.auth_user_member_identity_ids(project_id))
      )
      OR project_id IN (SELECT public.auth_user_coordinator_or_creator_project_ids())
      OR public.is_master()
    )
    AND EXISTS (
      SELECT 1
      FROM public.documents
      WHERE documents.id = reviews.document_id
        AND documents.project_id = reviews.project_id
    )
    AND (
      chosen_response_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM public.responses
        WHERE responses.id = reviews.chosen_response_id
          AND responses.project_id = reviews.project_id
          AND responses.document_id = reviews.document_id
      )
    )
  );

DROP POLICY IF EXISTS "Self reviewer inserts own row" ON public.field_reviews;
-- Não há chamador autenticado legítimo para INSERT: a criação inicial e o
-- reconcile usam o admin client. Manter um braço próprio permitia ao humano
-- fabricar a própria fila de auto-revisão e escolher as responses comparadas.

-- A policy histórica de coordenadores era FOR ALL e, portanto, continuava
-- oferecendo outro caminho autenticado de INSERT. A administração legítima
-- desta tabela precisa apenas de UPDATE/DELETE; a criação permanece exclusiva
-- do service role, como os dois callers de produção.
DROP POLICY IF EXISTS "Coordinators manage field_reviews" ON public.field_reviews;
DROP POLICY IF EXISTS "Coordinators update field_reviews" ON public.field_reviews;
CREATE POLICY "Coordinators update field_reviews" ON public.field_reviews FOR UPDATE
  USING (
    project_id IN (SELECT public.auth_user_coordinator_or_creator_project_ids())
    OR public.is_master()
  )
  WITH CHECK (
    project_id IN (SELECT public.auth_user_coordinator_or_creator_project_ids())
    OR public.is_master()
  );

DROP POLICY IF EXISTS "Coordinators delete field_reviews" ON public.field_reviews;
CREATE POLICY "Coordinators delete field_reviews" ON public.field_reviews FOR DELETE USING (
  project_id IN (SELECT public.auth_user_coordinator_or_creator_project_ids())
  OR public.is_master()
);

DROP POLICY IF EXISTS "Self reviewer updates own row" ON public.field_reviews;
CREATE POLICY "Self reviewer updates own row" ON public.field_reviews FOR UPDATE
  USING (
    project_id IN (SELECT public.auth_user_accessible_project_ids())
    AND self_reviewer_id IN (SELECT public.auth_user_member_identity_ids(project_id))
  )
  WITH CHECK (
    project_id IN (SELECT public.auth_user_accessible_project_ids())
    AND self_reviewer_id IN (SELECT public.auth_user_member_identity_ids(project_id))
  );

DROP POLICY IF EXISTS "Arbitrator updates own row" ON public.field_reviews;
CREATE POLICY "Arbitrator updates own row" ON public.field_reviews FOR UPDATE
  USING (
    project_id IN (SELECT public.auth_user_accessible_project_ids())
    AND arbitrator_id IN (SELECT public.auth_user_member_identity_ids(project_id))
  )
  WITH CHECK (
    project_id IN (SELECT public.auth_user_accessible_project_ids())
    AND arbitrator_id IN (SELECT public.auth_user_member_identity_ids(project_id))
  );

DROP POLICY IF EXISTS "Users update own field order" ON public.researcher_field_orders;
CREATE POLICY "Users update own field order" ON public.researcher_field_orders FOR UPDATE
  USING (
    user_id = public.clerk_uid()
    AND project_id IN (SELECT public.auth_user_accessible_project_ids())
  )
  WITH CHECK (
    user_id = public.clerk_uid()
    AND project_id IN (SELECT public.auth_user_accessible_project_ids())
  );

DROP POLICY IF EXISTS "Users delete own field order" ON public.researcher_field_orders;
CREATE POLICY "Users delete own field order" ON public.researcher_field_orders FOR DELETE USING (
  user_id = public.clerk_uid()
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
  author_id = public.clerk_uid()
  AND (
    project_id IN (SELECT public.auth_user_accessible_project_ids())
    OR public.is_master()
  )
  AND (
    document_id IS NULL
    OR EXISTS (
      SELECT 1
      FROM public.documents
      WHERE documents.id = project_comments.document_id
        AND documents.project_id = project_comments.project_id
    )
  )
);

DROP POLICY IF EXISTS "Authors can update own comments" ON public.project_comments;
CREATE POLICY "Authors can update own comments" ON public.project_comments FOR UPDATE
  USING (
    author_id = public.clerk_uid()
    AND project_id IN (SELECT public.auth_user_accessible_project_ids())
  )
  WITH CHECK (
    author_id = public.clerk_uid()
    AND project_id IN (SELECT public.auth_user_accessible_project_ids())
  );

DROP POLICY IF EXISTS "Authors can delete own pending exclusion requests" ON public.project_comments;
CREATE POLICY "Authors can delete own pending exclusion requests" ON public.project_comments FOR DELETE USING (
  kind = 'exclusion_request'
  AND author_id = public.clerk_uid()
  AND resolved_at IS NULL
  AND rejected_at IS NULL
  AND project_id IN (SELECT public.auth_user_accessible_project_ids())
);

DROP POLICY IF EXISTS "Coordinators can update project comments" ON public.project_comments;
CREATE POLICY "Coordinators can update project comments" ON public.project_comments FOR UPDATE
  USING (
    project_id IN (SELECT public.auth_user_coordinator_or_creator_project_ids())
    OR public.is_master()
  )
  WITH CHECK (
    project_id IN (SELECT public.auth_user_coordinator_or_creator_project_ids())
    OR public.is_master()
  );

DROP POLICY IF EXISTS "Members can view suggestions" ON public.schema_suggestions;
CREATE POLICY "Members can view suggestions" ON public.schema_suggestions FOR SELECT USING (
  project_id IN (SELECT public.auth_user_accessible_project_ids())
  OR public.is_master()
);

DROP POLICY IF EXISTS "Members can create suggestions" ON public.schema_suggestions;
CREATE POLICY "Members can create suggestions" ON public.schema_suggestions FOR INSERT WITH CHECK (
  (project_id IN (SELECT public.auth_user_accessible_project_ids()) OR public.is_master())
  AND suggested_by = public.clerk_uid()
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
  allowed_columns text[] := ARRAY[]::text[];
BEGIN
  IF NEW.document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.documents AS document
    WHERE document.id = NEW.document_id
      AND document.project_id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'project_comments.document_id must belong to project_id'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.parent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.project_comments AS parent
    WHERE parent.id = NEW.parent_id
      AND parent.project_id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'project_comments.parent_id must belong to project_id'
      USING ERRCODE = '23514';
  END IF;

  -- Scripts administrativos e o reconcile de identidade usam service role.
  -- Os vínculos cross-project acima continuam obrigatórios nesse caminho; a
  -- allowlist de ator só se aplica a sessões JWT.
  IF uid IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.author_id IS DISTINCT FROM uid
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
     AND NEW.resolved_by IS DISTINCT FROM uid THEN
    RAISE EXCEPTION 'resolved_by must identify the effective actor'
      USING ERRCODE = '42501';
  END IF;

  -- O autor edita o texto e pode resolver/reabrir o próprio comentário.
  IF OLD.author_id = uid THEN
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
  row_data jsonb := to_jsonb(NEW);
  v_response_id uuid;
  v_document_id uuid;
  allowed_columns text[];
BEGIN
  IF TG_TABLE_NAME IN ('difficulty_resolutions', 'note_resolutions') THEN
    v_response_id := (row_data->>'response_id')::uuid;

    IF NOT EXISTS (
      SELECT 1
      FROM public.responses AS response
      WHERE response.id = v_response_id
        AND response.project_id = NEW.project_id
    ) THEN
      RAISE EXCEPTION 'resolution response_id must belong to project_id'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_TABLE_NAME IN ('difficulty_resolutions', 'error_resolutions') THEN
    v_document_id := (row_data->>'document_id')::uuid;

    IF NOT EXISTS (
      SELECT 1
      FROM public.documents AS document
      WHERE document.id = v_document_id
        AND document.project_id = NEW.project_id
    ) THEN
      RAISE EXCEPTION 'resolution document_id must belong to project_id'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'difficulty_resolutions' AND NOT EXISTS (
    SELECT 1
    FROM public.responses AS response
    WHERE response.id = v_response_id
      AND response.document_id = v_document_id
  ) THEN
    RAISE EXCEPTION 'difficulty response_id must belong to document_id'
      USING ERRCODE = '23514';
  END IF;

  IF uid IS NULL THEN
    RETURN NEW;
  END IF;

  NEW.resolved_by := uid;
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

    IF NEW.suggested_by IS DISTINCT FROM uid
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
     OR NEW.resolved_by IS DISTINCT FROM uid
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

  IF TG_OP = 'INSERT' THEN
    IF NEW.respondent_id IS DISTINCT FROM uid
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

  IF OLD.respondent_id = uid THEN
    allowed_columns := allowed_columns || ARRAY['status', 'comment']::text[];
  END IF;

  IF public.is_master()
     OR project_id IN (SELECT public.auth_user_coordinator_or_creator_project_ids())
     OR project_id IN (SELECT public.auth_user_resolver_project_ids()) THEN
    allowed_columns := allowed_columns || ARRAY['resolved_at', 'resolved_by']::text[];
    IF NEW.resolved_by IS DISTINCT FROM OLD.resolved_by
       AND NEW.resolved_by IS NOT NULL
       AND NEW.resolved_by IS DISTINCT FROM uid THEN
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

  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by IS DISTINCT FROM uid THEN
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
  IF NEW.project_id IS NULL
     OR NEW.document_id IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM public.documents AS document
       WHERE document.id = NEW.document_id
         AND document.project_id = NEW.project_id
     ) THEN
    RAISE EXCEPTION 'assignments.document_id must belong to project_id'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.batch_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.assignment_batches AS batch
    WHERE batch.id = NEW.batch_id
      AND batch.project_id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'assignments.batch_id must belong to project_id'
      USING ERRCODE = '23514';
  END IF;

  IF uid IS NULL THEN
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
  SELECT project.* INTO response_project
  FROM public.projects AS project
  WHERE project.id = NEW.project_id;

  IF NOT FOUND OR NOT EXISTS (
    SELECT 1
    FROM public.documents AS document
    WHERE document.id = NEW.document_id
      AND document.project_id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'responses.document_id must belong to project_id'
      USING ERRCODE = '23514';
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
      IF NEW.round_id IS DISTINCT FROM response_project.current_round_id
         OR (
           NEW.round_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
             FROM public.rounds AS round
             WHERE round.id = NEW.round_id
               AND round.project_id = NEW.project_id
           )
         ) THEN
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
     OR NEW.respondent_id NOT IN (
       SELECT public.auth_user_member_identity_ids(NEW.project_id)
     ) THEN
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
  IF NOT EXISTS (
    SELECT 1
    FROM public.documents AS document
    WHERE document.id = NEW.document_id
      AND document.project_id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'reviews.document_id must belong to project_id'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.reviewer_id IS NULL THEN
    RAISE EXCEPTION 'reviews require reviewer_id'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.chosen_response_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.responses AS response
    WHERE response.id = NEW.chosen_response_id
      AND response.project_id = NEW.project_id
      AND response.document_id = NEW.document_id
  ) THEN
    RAISE EXCEPTION 'reviews.chosen_response_id must belong to the same document and project'
      USING ERRCODE = '23514';
  END IF;

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
      SELECT count(*)
      FROM jsonb_array_elements(NEW.response_snapshot)
    ) IS DISTINCT FROM (
      SELECT count(*)
      FROM public.responses AS response
      WHERE response.project_id = NEW.project_id
        AND response.document_id = NEW.document_id
        AND response.answers ? NEW.field_name
    ) OR (
      SELECT count(DISTINCT item->>'id')
      FROM jsonb_array_elements(NEW.response_snapshot) AS items(item)
    ) IS DISTINCT FROM (
      SELECT count(*)
      FROM jsonb_array_elements(NEW.response_snapshot)
    ) THEN
      RAISE EXCEPTION 'reviews.response_snapshot must match the document responses'
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

-- A proposta #446 corrige a identidade efetiva da policy, mas a tabela ainda
-- tinha FKs simples: era possível combinar project_id acessível com documento
-- e responses de outro projeto, ou usar o braço administrativo para registrar
-- reviewer_id alheio. O guard mantém a policy de alias e fecha o domínio da
-- própria equivalência.
CREATE OR REPLACE FUNCTION public.enforce_response_equivalence_scope_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid uuid := public.clerk_uid();
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.documents AS document
    WHERE document.id = NEW.document_id
      AND document.project_id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'response_equivalences.document_id must belong to project_id'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.responses AS response
    WHERE response.id = NEW.response_a_id
      AND response.project_id = NEW.project_id
      AND response.document_id = NEW.document_id
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.responses AS response
    WHERE response.id = NEW.response_b_id
      AND response.project_id = NEW.project_id
      AND response.document_id = NEW.document_id
  ) THEN
    RAISE EXCEPTION 'equivalent responses must belong to the same document and project'
      USING ERRCODE = '23514';
  END IF;

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
  allowed_columns text[] := ARRAY[]::text[];
  actor_authorized boolean := false;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.documents AS document
    WHERE document.id = NEW.document_id
      AND document.project_id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'field_reviews.document_id must belong to project_id'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.responses AS response
    WHERE response.id = NEW.human_response_id
      AND response.project_id = NEW.project_id
      AND response.document_id = NEW.document_id
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
      AND response.project_id = NEW.project_id
      AND response.document_id = NEW.document_id
      AND response.respondent_type = 'llm'
  ) THEN
    RAISE EXCEPTION 'llm_response_id must identify an LLM response in this document'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.arbitrator_id IS NOT NULL AND NOT EXISTS (
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

  -- O service role cria/reconcilia filas e coordenadores atribuem árbitros.
  -- Os invariantes acima valem para ambos; apenas a allowlist de ator é
  -- dispensada para o caminho administrativo.
  IF uid IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'field_reviews INSERT is restricted to service role'
      USING ERRCODE = '42501';
  END IF;

  IF (
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

  IF public.is_master()
     OR NEW.project_id IN (SELECT public.auth_user_coordinator_or_creator_project_ids()) THEN
    RETURN NEW;
  END IF;

  IF OLD.self_reviewer_id IN (
    SELECT public.auth_user_member_identity_ids(OLD.project_id)
  ) THEN
    actor_authorized := true;
    allowed_columns := allowed_columns || ARRAY[
      'self_verdict', 'self_reviewed_at', 'self_justification'
    ]::text[];
  END IF;

  IF OLD.arbitrator_id IN (
    SELECT public.auth_user_member_identity_ids(OLD.project_id)
  ) THEN
    actor_authorized := true;
    allowed_columns := allowed_columns || ARRAY[
      'blind_verdict', 'blind_decided_at', 'final_verdict', 'final_decided_at',
      'question_improvement_suggestion', 'arbitrator_comment'
    ]::text[];
  END IF;

  IF NOT actor_authorized THEN
    RAISE EXCEPTION 'actor is neither the self reviewer nor the arbitrator'
      USING ERRCODE = '42501';
  END IF;

  -- Em BEFORE UPDATE o PostgreSQL expõe a coluna generated como NULL em NEW,
  -- enquanto OLD contém o valor armazenado. Ela não é gravável pelo caller e
  -- deve ser excluída da comparação para não produzir falso positivo.
  IF (to_jsonb(NEW) - (allowed_columns || ARRAY['changed_after_justification']::text[]))
     IS DISTINCT FROM
     (to_jsonb(OLD) - (allowed_columns || ARRAY['changed_after_justification']::text[])) THEN
    RAISE EXCEPTION 'field review update contains columns outside the actor phase'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_field_review_column_guard_trigger ON public.field_reviews;
CREATE TRIGGER enforce_field_review_column_guard_trigger
  BEFORE INSERT OR UPDATE ON public.field_reviews
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_field_review_column_guard();

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

-- Estas duas funções são RPCs de usuário autenticado. O grant default para
-- PUBLIC contradizia o contrato explícito das migrations que as introduziram.
REVOKE ALL ON FUNCTION public.apply_lottery_assignments(uuid, text, uuid, jsonb, boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.apply_lottery_assignments(uuid, text, uuid, jsonb, boolean) TO authenticated;

REVOKE ALL ON FUNCTION public.replace_and_add_documents(uuid, uuid[], boolean, jsonb, jsonb) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.replace_and_add_documents(uuid, uuid[], boolean, jsonb, jsonb) TO authenticated;

-- Não há chamador no repositório e a função genérica permitia alterar JSON de
-- respostas fora do fluxo canônico de saveResponse.
DROP FUNCTION IF EXISTS public.remove_answer_key(uuid, text);
