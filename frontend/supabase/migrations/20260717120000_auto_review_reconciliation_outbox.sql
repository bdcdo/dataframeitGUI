-- Auto-review cycles and queue reconciliation.
--
-- `responses.answers` is mutable, while the old `(document_id, field_name)`
-- row in field_reviews mixed the identity of a review with the value that was
-- reviewed. A later edit could therefore leave a verdict attached to another
-- answer. The operational tables keep only current state; before a changed pair
-- is replaced or removed, its immutable snapshot is copied to a history table.
--
-- Rollout is deliberately additive. The original full UNIQUE constraints stay
-- in place, so an older frontend can keep using its existing ON CONFLICT clauses
-- while the cycle-aware frontend is deployed. The old auto-review assignment is
-- projected only during that mixed-version window; cycle-aware code reads
-- field_reviews directly. LLM publications enqueue durable reconciliation work
-- so a frontend outage cannot lose a queue reopen.
BEGIN;

ALTER TABLE public.project_comments
  ADD COLUMN field_review_id UUID;

CREATE UNIQUE INDEX project_comments_field_review_author_unique
  ON public.project_comments(field_review_id, author_id)
  WHERE field_review_id IS NOT NULL;

ALTER TABLE public.field_reviews
  ADD COLUMN cycle_no INTEGER,
  ADD COLUMN superseded_at TIMESTAMPTZ,
  ADD COLUMN superseded_reason TEXT,
  ADD COLUMN human_answer_snapshot JSONB,
  ADD COLUMN llm_answer_snapshot JSONB,
  ADD COLUMN llm_justification_snapshot JSONB,
  ADD COLUMN snapshot_reliable BOOLEAN NOT NULL DEFAULT true;

UPDATE public.field_reviews AS review
SET cycle_no = 1,
    human_answer_snapshot = human.answers -> review.field_name,
    llm_answer_snapshot = llm.answers -> review.field_name,
    llm_justification_snapshot = llm.justifications -> review.field_name,
    snapshot_reliable = CASE
      WHEN human.updated_at <= review.created_at
      AND llm.updated_at <= review.created_at THEN true
      ELSE false
    END
FROM public.responses AS human,
     public.responses AS llm
WHERE human.id = review.human_response_id
  AND llm.id = review.llm_response_id;

ALTER TABLE public.field_reviews
  ALTER COLUMN cycle_no SET NOT NULL,
  ALTER COLUMN cycle_no SET DEFAULT 1,
  ADD CONSTRAINT field_reviews_cycle_positive CHECK (cycle_no > 0),
  ADD CONSTRAINT field_reviews_superseded_reason_check CHECK (
    superseded_reason IS NULL OR superseded_reason IN (
      'answer_changed',
      'llm_changed',
      'no_longer_divergent',
      'legacy_response_changed'
    )
  );

-- field_reviews is now the canonical queue. Authenticated users may decide
-- their own phase, but only service-owned producers may create queue rows.
DROP POLICY IF EXISTS "Self reviewer inserts own row" ON public.field_reviews;
DROP POLICY IF EXISTS "Coordinators manage field_reviews" ON public.field_reviews;

CREATE POLICY "Coordinators update field_reviews"
ON public.field_reviews FOR UPDATE
USING (
  project_id IN (
    SELECT public.auth_user_coordinator_or_creator_project_ids()
  )
  OR public.is_master()
)
WITH CHECK (
  project_id IN (
    SELECT public.auth_user_coordinator_or_creator_project_ids()
  )
  OR public.is_master()
);

CREATE OR REPLACE FUNCTION public.guard_field_review_update_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_is_self_reviewer BOOLEAN;
  v_is_arbitrator BOOLEAN;
  v_is_coordinator BOOLEAN;
  v_self_phase_changed BOOLEAN;
  v_arbitration_phase_changed BOOLEAN;
BEGIN
  IF SESSION_USER = 'postgres' OR auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.auth_user_member_identity_ids(OLD.project_id) AS identity(id)
    WHERE identity.id = OLD.self_reviewer_id
  ) INTO v_is_self_reviewer;

  SELECT EXISTS (
    SELECT 1
    FROM public.auth_user_member_identity_ids(OLD.project_id) AS identity(id)
    WHERE identity.id = OLD.arbitrator_id
  ) INTO v_is_arbitrator;

  SELECT (
    OLD.project_id IN (
      SELECT public.auth_user_coordinator_or_creator_project_ids()
    )
    OR public.is_master()
  ) INTO v_is_coordinator;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.document_id IS DISTINCT FROM OLD.document_id
     OR NEW.field_name IS DISTINCT FROM OLD.field_name
     OR NEW.human_response_id IS DISTINCT FROM OLD.human_response_id
     OR NEW.llm_response_id IS DISTINCT FROM OLD.llm_response_id
     OR NEW.self_reviewer_id IS DISTINCT FROM OLD.self_reviewer_id
     OR NEW.cycle_no IS DISTINCT FROM OLD.cycle_no
     OR NEW.human_answer_snapshot IS DISTINCT FROM OLD.human_answer_snapshot
     OR NEW.llm_answer_snapshot IS DISTINCT FROM OLD.llm_answer_snapshot
     OR NEW.llm_justification_snapshot IS DISTINCT FROM OLD.llm_justification_snapshot
     OR NEW.snapshot_reliable IS DISTINCT FROM OLD.snapshot_reliable
     OR NEW.superseded_at IS DISTINCT FROM OLD.superseded_at
     OR NEW.superseded_reason IS DISTINCT FROM OLD.superseded_reason
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'review cycle identity and snapshots are immutable';
  END IF;

  v_self_phase_changed :=
    NEW.self_verdict IS DISTINCT FROM OLD.self_verdict
    OR NEW.self_reviewed_at IS DISTINCT FROM OLD.self_reviewed_at
    OR NEW.self_justification IS DISTINCT FROM OLD.self_justification;

  IF v_self_phase_changed AND NOT v_is_self_reviewer THEN
    RAISE EXCEPTION 'only the self reviewer may decide the self-review phase';
  END IF;
  IF OLD.self_verdict IS NOT NULL
     AND NEW.self_verdict IS DISTINCT FROM OLD.self_verdict THEN
    RAISE EXCEPTION 'self-review verdict is immutable after submission';
  END IF;

  IF NEW.arbitrator_id IS DISTINCT FROM OLD.arbitrator_id
     AND NOT v_is_coordinator THEN
    RAISE EXCEPTION 'only coordinators may change the arbitrator';
  END IF;

  v_arbitration_phase_changed :=
    NEW.blind_verdict IS DISTINCT FROM OLD.blind_verdict
    OR NEW.blind_decided_at IS DISTINCT FROM OLD.blind_decided_at
    OR NEW.final_verdict IS DISTINCT FROM OLD.final_verdict
    OR NEW.final_decided_at IS DISTINCT FROM OLD.final_decided_at
    OR NEW.question_improvement_suggestion IS DISTINCT FROM
       OLD.question_improvement_suggestion
    OR NEW.arbitrator_comment IS DISTINCT FROM OLD.arbitrator_comment;

  IF v_arbitration_phase_changed
     AND NOT v_is_arbitrator
     AND NOT (
       v_is_coordinator
       AND NEW.arbitrator_id IS NULL
       AND NEW.blind_verdict IS NULL
       AND OLD.final_verdict IS NULL
     ) THEN
    RAISE EXCEPTION 'only the arbitrator may decide the arbitration phase';
  END IF;
  IF NOT v_is_coordinator
     AND OLD.blind_verdict IS NOT NULL
     AND NEW.blind_verdict IS DISTINCT FROM OLD.blind_verdict THEN
    RAISE EXCEPTION 'blind verdict is immutable after submission';
  END IF;
  IF OLD.final_verdict IS NOT NULL
     AND NEW.final_verdict IS DISTINCT FROM OLD.final_verdict THEN
    RAISE EXCEPTION 'final verdict is immutable after submission';
  END IF;
  IF OLD.final_verdict IS NULL
     AND NEW.final_verdict IS NOT NULL
     AND NEW.blind_verdict IS NULL THEN
    RAISE EXCEPTION 'blind verdict must be submitted before final verdict';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_field_review_update_columns()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON CONSTRAINT field_reviews_unique ON public.field_reviews IS
  'One operational row per document/field. Previous cycles live in field_review_cycle_history_entries.';

CREATE TABLE public.field_review_cycle_history_entries
AS TABLE public.field_reviews WITH NO DATA;

ALTER TABLE public.field_review_cycle_history_entries
  ADD PRIMARY KEY (id),
  ADD CONSTRAINT field_review_cycle_history_cycle_unique
  UNIQUE (document_id, field_name, cycle_no),
  ADD CONSTRAINT field_review_cycle_history_project_fk
  FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE,
  ADD CONSTRAINT field_review_cycle_history_document_fk
  FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE,
  ALTER COLUMN superseded_at SET NOT NULL,
  ALTER COLUMN superseded_reason SET NOT NULL;

ALTER TABLE public.field_review_cycle_history_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members view field review cycle history"
ON public.field_review_cycle_history_entries
FOR SELECT USING (
  project_id IN (SELECT public.auth_user_accessible_project_ids())
  OR public.is_master()
);

CREATE INDEX idx_field_review_cycle_history_dependency
  ON public.field_review_cycle_history_entries(
    project_id, document_id, self_reviewer_id
  );

-- A mutable response may already have changed after a historical verdict. The
-- old row remains as evidence of that verdict, but cannot stay active because
-- its exact reviewed value is unknowable. A new pending cycle snapshots the
-- current values conservatively; the first cycle-aware reconciliation removes
-- it if the field is no longer divergent.
UPDATE public.field_reviews
SET superseded_at = pg_catalog.now(),
    superseded_reason = 'legacy_response_changed'
WHERE snapshot_reliable = false;

INSERT INTO public.field_review_cycle_history_entries
SELECT review.*
FROM public.field_reviews AS review
WHERE review.snapshot_reliable = false;

UPDATE public.field_reviews AS review
SET id = pg_catalog.gen_random_uuid(),
    cycle_no = review.cycle_no + 1,
    human_answer_snapshot = human.answers -> review.field_name,
    llm_answer_snapshot = llm.answers -> review.field_name,
    llm_justification_snapshot = llm.justifications -> review.field_name,
    snapshot_reliable = true,
    self_verdict = NULL,
    self_reviewed_at = NULL,
    self_justification = NULL,
    arbitrator_id = NULL,
    blind_verdict = NULL,
    blind_decided_at = NULL,
    final_verdict = NULL,
    final_decided_at = NULL,
    question_improvement_suggestion = NULL,
    arbitrator_comment = NULL,
    created_at = pg_catalog.now(),
    superseded_at = NULL,
    superseded_reason = NULL
FROM public.responses AS human,
     public.responses AS llm
WHERE review.snapshot_reliable = false
  AND human.id = review.human_response_id
  AND llm.id = review.llm_response_id
  AND human.is_latest = true
  AND llm.is_latest = true;

DELETE FROM public.field_reviews
WHERE snapshot_reliable = false;

-- Install the runtime guard only after the one-time legacy rotation. The
-- Supabase migration role is neither postgres nor a service-role JWT, so
-- installing it earlier would correctly reject this migration's own rewrite.
CREATE TRIGGER guard_field_review_update_columns
BEFORE UPDATE ON public.field_reviews
FOR EACH ROW EXECUTE FUNCTION public.guard_field_review_update_columns();

CREATE OR REPLACE FUNCTION public.snapshot_field_review_cycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_human public.responses%ROWTYPE;
  v_llm public.responses%ROWTYPE;
BEGIN
  SELECT * INTO v_human
  FROM public.responses
  WHERE id = NEW.human_response_id;

  SELECT * INTO v_llm
  FROM public.responses
  WHERE id = NEW.llm_response_id;

  IF v_human.id IS NULL
     OR v_llm.id IS NULL
     OR v_human.respondent_type <> 'humano'
     OR v_llm.respondent_type <> 'llm'
     OR v_human.project_id IS DISTINCT FROM NEW.project_id
     OR v_llm.project_id IS DISTINCT FROM NEW.project_id
     OR v_human.document_id IS DISTINCT FROM NEW.document_id
     OR v_llm.document_id IS DISTINCT FROM NEW.document_id
     OR v_human.respondent_id IS DISTINCT FROM NEW.self_reviewer_id THEN
    RAISE EXCEPTION 'field review responses must match its project, document, and reviewer';
  END IF;

  SELECT COALESCE(max(history.cycle_no) + 1, 1)
  INTO NEW.cycle_no
  FROM public.field_review_cycle_history_entries AS history
  WHERE history.document_id = NEW.document_id
    AND history.field_name = NEW.field_name;

  NEW.human_answer_snapshot := v_human.answers -> NEW.field_name;
  NEW.llm_answer_snapshot := v_llm.answers -> NEW.field_name;
  NEW.llm_justification_snapshot := v_llm.justifications -> NEW.field_name;
  NEW.snapshot_reliable := true;
  NEW.superseded_at := NULL;
  NEW.superseded_reason := NULL;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.snapshot_field_review_cycle()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER snapshot_field_review_cycle
BEFORE INSERT ON public.field_reviews
FOR EACH ROW EXECUTE FUNCTION public.snapshot_field_review_cycle();

CREATE OR REPLACE FUNCTION public.archive_field_review_before_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_review public.field_reviews%ROWTYPE;
  v_reason TEXT;
BEGIN
  v_review := OLD;
  v_review.superseded_at := COALESCE(v_review.superseded_at, pg_catalog.now());

  SELECT CASE
    WHEN human.is_latest IS DISTINCT FROM true
      OR OLD.human_answer_snapshot IS DISTINCT FROM
         human.answers -> OLD.field_name
    THEN 'answer_changed'
    WHEN llm.is_latest IS DISTINCT FROM true
      OR OLD.llm_answer_snapshot IS DISTINCT FROM
         llm.answers -> OLD.field_name
      OR OLD.llm_justification_snapshot IS DISTINCT FROM
         llm.justifications -> OLD.field_name
    THEN 'llm_changed'
    ELSE 'no_longer_divergent'
  END
  INTO v_reason
  FROM public.responses AS human,
       public.responses AS llm
  WHERE human.id = OLD.human_response_id
    AND llm.id = OLD.llm_response_id;

  v_review.superseded_reason := COALESCE(
    v_review.superseded_reason,
    v_reason,
    'no_longer_divergent'
  );

  INSERT INTO public.field_review_cycle_history_entries
  SELECT v_review.*
  ON CONFLICT (id) DO NOTHING;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.archive_field_review_before_delete()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER archive_field_review_before_delete
BEFORE DELETE ON public.field_reviews
FOR EACH ROW EXECUTE FUNCTION public.archive_field_review_before_delete();

INSERT INTO public.assignments (
  project_id,
  document_id,
  user_id,
  type,
  status
)
SELECT DISTINCT
  review.project_id,
  review.document_id,
  review.self_reviewer_id,
  'auto_revisao',
  'pendente'
FROM public.field_reviews AS review
WHERE review.superseded_at IS NULL
  AND review.self_verdict IS NULL
ON CONFLICT (document_id, user_id, type) DO UPDATE
SET status = 'pendente', completed_at = NULL;

UPDATE public.assignments AS assignment
SET status = 'concluido', completed_at = pg_catalog.now()
WHERE assignment.type = 'auto_revisao'
  AND assignment.status <> 'concluido'
  AND NOT EXISTS (
    SELECT 1
    FROM public.field_reviews AS review
    WHERE review.project_id = assignment.project_id
      AND review.document_id = assignment.document_id
      AND review.self_reviewer_id = assignment.user_id
      AND review.superseded_at IS NULL
      AND review.self_verdict IS NULL
  );

DELETE FROM public.assignments AS assignment
WHERE assignment.type = 'arbitragem'
  AND assignment.status <> 'concluido'
  AND NOT EXISTS (
    SELECT 1
    FROM public.field_reviews AS review
    WHERE review.project_id = assignment.project_id
      AND review.document_id = assignment.document_id
      AND review.arbitrator_id = assignment.user_id
      AND review.superseded_at IS NULL
      AND review.final_verdict IS NULL
  );

CREATE INDEX idx_field_reviews_current_self_queue
  ON public.field_reviews(project_id, self_reviewer_id, document_id)
  WHERE superseded_at IS NULL AND self_verdict IS NULL;

CREATE INDEX idx_field_reviews_current_arbitration_queue
  ON public.field_reviews(project_id, arbitrator_id, document_id)
  WHERE superseded_at IS NULL
    AND self_verdict = 'contesta_llm'
    AND final_verdict IS NULL;

ALTER TABLE public.response_equivalences
  ADD COLUMN response_a_answer_snapshot JSONB,
  ADD COLUMN response_b_answer_snapshot JSONB,
  ADD COLUMN superseded_at TIMESTAMPTZ,
  ADD COLUMN superseded_reason TEXT,
  ADD CONSTRAINT response_equivalences_superseded_reason_check CHECK (
    superseded_reason IS NULL OR superseded_reason IN (
      'answer_changed',
      'response_revised',
      'manually_removed',
      'legacy_response_changed'
    )
  );

UPDATE public.response_equivalences AS equivalence
SET response_a_answer_snapshot = response_a.answers -> equivalence.field_name,
    response_b_answer_snapshot = response_b.answers -> equivalence.field_name,
    superseded_at = CASE
      WHEN response_a.updated_at > equivalence.created_at
        OR response_b.updated_at > equivalence.created_at
      THEN pg_catalog.now()
      ELSE NULL
    END,
    superseded_reason = CASE
      WHEN response_a.updated_at > equivalence.created_at
        OR response_b.updated_at > equivalence.created_at
      THEN 'legacy_response_changed'
      ELSE NULL
    END
FROM public.responses AS response_a,
     public.responses AS response_b
WHERE response_a.id = equivalence.response_a_id
  AND response_b.id = equivalence.response_b_id;

COMMENT ON CONSTRAINT response_equivalences_project_id_document_id_field_name_res_key
ON public.response_equivalences IS
  'One operational row per response pair. Previous decisions live in response_equivalence_history_entries.';

CREATE TABLE public.response_equivalence_history_entries
AS TABLE public.response_equivalences WITH NO DATA;

ALTER TABLE public.response_equivalence_history_entries
  ADD PRIMARY KEY (id),
  ADD CONSTRAINT response_equivalence_history_project_fk
  FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE,
  ADD CONSTRAINT response_equivalence_history_document_fk
  FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE,
  ALTER COLUMN superseded_at SET NOT NULL,
  ALTER COLUMN superseded_reason SET NOT NULL;

ALTER TABLE public.response_equivalence_history_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members view response equivalence history"
ON public.response_equivalence_history_entries
FOR SELECT USING (
  project_id IN (SELECT public.auth_user_project_ids())
  OR project_id IN (
    SELECT project.id
    FROM public.projects AS project
    WHERE project.created_by = public.clerk_uid()
  )
  OR public.is_master()
);

CREATE INDEX idx_response_equivalence_history_project_document
  ON public.response_equivalence_history_entries(project_id, document_id);

INSERT INTO public.response_equivalence_history_entries
SELECT equivalence.*
FROM public.response_equivalences AS equivalence
WHERE equivalence.superseded_at IS NOT NULL;

DELETE FROM public.response_equivalences
WHERE superseded_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.archive_response_equivalence_before_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_equivalence public.response_equivalences%ROWTYPE;
  v_reason TEXT;
BEGIN
  v_equivalence := OLD;
  v_equivalence.superseded_at := COALESCE(
    v_equivalence.superseded_at,
    pg_catalog.now()
  );
  SELECT CASE
    WHEN response_a.is_latest IS DISTINCT FROM true
      OR response_b.is_latest IS DISTINCT FROM true
    THEN 'response_revised'
    WHEN OLD.response_a_answer_snapshot IS DISTINCT FROM
         response_a.answers -> OLD.field_name
      OR OLD.response_b_answer_snapshot IS DISTINCT FROM
         response_b.answers -> OLD.field_name
    THEN 'answer_changed'
    ELSE 'manually_removed'
  END
  INTO v_reason
  FROM public.responses AS response_a,
       public.responses AS response_b
  WHERE response_a.id = OLD.response_a_id
    AND response_b.id = OLD.response_b_id;

  v_equivalence.superseded_reason := COALESCE(
    v_equivalence.superseded_reason,
    v_reason,
    'manually_removed'
  );

  INSERT INTO public.response_equivalence_history_entries
  SELECT v_equivalence.*
  ON CONFLICT (id) DO NOTHING;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.archive_response_equivalence_before_delete()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER archive_response_equivalence_before_delete
BEFORE DELETE ON public.response_equivalences
FOR EACH ROW EXECUTE FUNCTION public.archive_response_equivalence_before_delete();

CREATE OR REPLACE FUNCTION public.archive_review_dependencies_on_response_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.field_reviews AS review
  WHERE (
    review.human_response_id = NEW.id
    AND (
      OLD.is_latest = true AND NEW.is_latest = false
      OR review.human_answer_snapshot IS DISTINCT FROM
         NEW.answers -> review.field_name
    )
  ) OR (
    review.llm_response_id = NEW.id
    AND (
      OLD.is_latest = true AND NEW.is_latest = false
      OR review.llm_answer_snapshot IS DISTINCT FROM
         NEW.answers -> review.field_name
      OR review.llm_justification_snapshot IS DISTINCT FROM
         NEW.justifications -> review.field_name
    )
  );

  DELETE FROM public.response_equivalences AS equivalence
  WHERE (
    equivalence.response_a_id = NEW.id
    AND (
      OLD.is_latest = true AND NEW.is_latest = false
      OR equivalence.response_a_answer_snapshot IS DISTINCT FROM
         NEW.answers -> equivalence.field_name
    )
  ) OR (
    equivalence.response_b_id = NEW.id
    AND (
      OLD.is_latest = true AND NEW.is_latest = false
      OR equivalence.response_b_answer_snapshot IS DISTINCT FROM
         NEW.answers -> equivalence.field_name
    )
  );

  UPDATE public.assignments AS assignment
  SET status = 'concluido', completed_at = pg_catalog.now()
  WHERE assignment.project_id = NEW.project_id
    AND assignment.document_id = NEW.document_id
    AND assignment.type = 'auto_revisao'
    AND NOT EXISTS (
      SELECT 1
      FROM public.field_reviews AS review
      WHERE review.project_id = assignment.project_id
        AND review.document_id = assignment.document_id
        AND review.self_reviewer_id = assignment.user_id
        AND review.self_verdict IS NULL
    );

  DELETE FROM public.assignments AS assignment
  WHERE assignment.project_id = NEW.project_id
    AND assignment.document_id = NEW.document_id
    AND assignment.type = 'arbitragem'
    AND assignment.status <> 'concluido'
    AND NOT EXISTS (
      SELECT 1
      FROM public.field_reviews AS review
      WHERE review.project_id = assignment.project_id
        AND review.document_id = assignment.document_id
        AND review.arbitrator_id = assignment.user_id
        AND review.final_verdict IS NULL
    );

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.archive_review_dependencies_on_response_change()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER archive_review_dependencies_on_response_change
AFTER UPDATE OF answers, justifications, is_latest ON public.responses
FOR EACH ROW
WHEN (
  OLD.answers IS DISTINCT FROM NEW.answers
  OR OLD.justifications IS DISTINCT FROM NEW.justifications
  OR (OLD.is_latest = true AND NEW.is_latest = false)
)
EXECUTE FUNCTION public.archive_review_dependencies_on_response_change();

-- Replacing the latest LLM response and requesting reconciliation are one
-- transaction. The worker may be unavailable when this commits; the request
-- remains durable and final_answers fails closed until it is acknowledged.
CREATE TABLE public.auto_review_reconciliation_requests (
  document_id UUID PRIMARY KEY
    REFERENCES public.documents(id) ON DELETE CASCADE,
  project_id UUID NOT NULL
    REFERENCES public.projects(id) ON DELETE CASCADE,
  llm_response_id UUID UNIQUE
    REFERENCES public.responses(id) ON DELETE CASCADE,
  allow_new_cycles BOOLEAN NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT
);

CREATE OR REPLACE FUNCTION public.validate_auto_review_reconciliation_request()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.documents AS document
    WHERE document.id = NEW.document_id
      AND document.project_id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'reconciliation request document does not belong to project';
  END IF;

  IF NEW.llm_response_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.responses AS llm
    WHERE llm.id = NEW.llm_response_id
      AND llm.project_id = NEW.project_id
      AND llm.document_id = NEW.document_id
      AND llm.respondent_type = 'llm'
      AND llm.is_latest = true
      AND llm.is_partial = false
  ) THEN
    RAISE EXCEPTION 'reconciliation request must reference its current complete LLM response';
  END IF;
  IF NEW.llm_response_id IS NULL AND NOT EXISTS (
    SELECT 1
    FROM public.responses AS human
    WHERE human.project_id = NEW.project_id
      AND human.document_id = NEW.document_id
      AND human.respondent_type = 'humano'
      AND human.is_latest = true
      AND human.is_partial = false
  ) THEN
    RAISE EXCEPTION 'reconciliation request without an LLM must reference a complete human response';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.validate_auto_review_reconciliation_request()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER validate_auto_review_reconciliation_request
BEFORE INSERT OR UPDATE OF project_id, document_id, llm_response_id
ON public.auto_review_reconciliation_requests
FOR EACH ROW EXECUTE FUNCTION public.validate_auto_review_reconciliation_request();

ALTER TABLE public.auto_review_reconciliation_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.auto_review_reconciliation_requests
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.auto_review_reconciliation_requests TO service_role;

CREATE OR REPLACE FUNCTION public.is_auto_review_reconciliation_pending(
  p_project_id UUID,
  p_document_id UUID,
  p_llm_response_id UUID
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT (
    SESSION_USER = 'postgres'
    OR auth.role() = 'service_role'
    OR p_project_id IN (SELECT public.auth_user_accessible_project_ids())
  ) AND EXISTS (
    SELECT 1
    FROM public.auto_review_reconciliation_requests AS request
    WHERE request.project_id = p_project_id
      AND request.document_id = p_document_id
      AND (
        request.llm_response_id IS NULL
        OR request.llm_response_id = p_llm_response_id
      )
  );
$$;

REVOKE ALL ON FUNCTION public.is_auto_review_reconciliation_pending(UUID, UUID, UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_auto_review_reconciliation_pending(UUID, UUID, UUID)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.enqueue_auto_review_reconciliation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_allow_new_cycles BOOLEAN;
  v_llm_response_id UUID;
BEGIN
  IF NEW.respondent_type NOT IN ('humano', 'llm')
     OR NEW.is_latest IS DISTINCT FROM true
     OR NEW.is_partial IS DISTINCT FROM false THEN
    RETURN NEW;
  END IF;

  -- The document row is the publication mutex shared with
  -- publish_latest_llm_response. A concurrent human save therefore observes
  -- either the previous or the next complete LLM generation as a whole; it
  -- cannot overwrite a new outbox request with a stale response id.
  PERFORM 1
  FROM public.documents AS document
  WHERE document.id = NEW.document_id
    AND document.project_id = NEW.project_id
  FOR UPDATE;

  SELECT project.automation_mode = 'auto_review_llm'
  INTO v_allow_new_cycles
  FROM public.projects AS project
  WHERE project.id = NEW.project_id;

  IF NEW.respondent_type = 'humano' THEN
    IF NOT COALESCE(v_allow_new_cycles, false)
       AND NOT EXISTS (
         SELECT 1 FROM public.field_reviews AS review
         WHERE review.project_id = NEW.project_id
           AND review.document_id = NEW.document_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.field_review_cycle_history_entries AS history
         WHERE history.project_id = NEW.project_id
           AND history.document_id = NEW.document_id
       ) THEN
      RETURN NEW;
    END IF;

    SELECT llm.id INTO v_llm_response_id
    FROM public.responses AS llm
    WHERE llm.project_id = NEW.project_id
      AND llm.document_id = NEW.document_id
      AND llm.respondent_type = 'llm'
      AND llm.is_latest = true
      AND llm.is_partial = false;
  ELSE
    v_llm_response_id := NEW.id;
  END IF;

  INSERT INTO public.auto_review_reconciliation_requests (
    document_id, project_id, llm_response_id, allow_new_cycles
  ) VALUES (
    NEW.document_id, NEW.project_id, v_llm_response_id,
    COALESCE(v_allow_new_cycles, false)
  )
  ON CONFLICT (document_id) DO UPDATE
  SET project_id = EXCLUDED.project_id,
      llm_response_id = EXCLUDED.llm_response_id,
      allow_new_cycles = EXCLUDED.allow_new_cycles,
      requested_at = pg_catalog.now(),
      next_attempt_at = pg_catalog.now(),
      attempt_count = 0,
      last_error = NULL;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_auto_review_reconciliation()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER enqueue_auto_review_reconciliation
AFTER INSERT OR UPDATE OF answers, answer_field_hashes, is_latest, is_partial
ON public.responses
FOR EACH ROW EXECUTE FUNCTION public.enqueue_auto_review_reconciliation();

CREATE INDEX auto_review_reconciliation_requests_due
  ON public.auto_review_reconciliation_requests(next_attempt_at, requested_at);

-- Existing data may predate the single-latest invariant. Resolve it
-- deterministically before making concurrent reruns unable to recreate it.
UPDATE public.responses
SET is_latest = false
WHERE respondent_type = 'llm'
  AND is_partial = true
  AND is_latest = true;

WITH ranked_latest_llm AS (
  SELECT response.id,
         pg_catalog.row_number() OVER (
           PARTITION BY response.project_id, response.document_id
           ORDER BY response.created_at DESC, response.id DESC
         ) AS position
  FROM public.responses AS response
  WHERE response.respondent_type = 'llm'
    AND response.is_latest = true
)
UPDATE public.responses AS response
SET is_latest = false
FROM ranked_latest_llm AS ranked
WHERE response.id = ranked.id
  AND ranked.position > 1;

ALTER TABLE public.responses
  ADD CONSTRAINT responses_partial_llm_not_latest CHECK (
    respondent_type <> 'llm' OR is_partial = false OR is_latest = false
  );

CREATE UNIQUE INDEX responses_one_latest_llm_per_document
  ON public.responses(project_id, document_id)
  WHERE respondent_type = 'llm' AND is_latest = true;

CREATE OR REPLACE FUNCTION public.publish_latest_llm_response(
  p_response JSONB
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_project_id UUID;
  v_document_id UUID;
  v_document_project_id UUID;
  v_response_id UUID;
  v_is_partial BOOLEAN;
BEGIN
  IF p_response IS NULL OR pg_catalog.jsonb_typeof(p_response) <> 'object' THEN
    RAISE EXCEPTION 'p_response must be a JSON object';
  END IF;
  IF pg_catalog.jsonb_typeof(p_response->'answers') <> 'object'
     OR (
       p_response->'justifications' IS NOT NULL
       AND p_response->'justifications' <> 'null'::JSONB
       AND pg_catalog.jsonb_typeof(p_response->'justifications') <> 'object'
     )
     OR (
       p_response->'answer_field_hashes' IS NOT NULL
       AND p_response->'answer_field_hashes' <> 'null'::JSONB
       AND pg_catalog.jsonb_typeof(p_response->'answer_field_hashes') <> 'object'
     ) THEN
    RAISE EXCEPTION 'LLM response answers, justifications, and field hashes must be JSON objects';
  END IF;

  v_project_id := (p_response->>'project_id')::UUID;
  v_document_id := (p_response->>'document_id')::UUID;
  v_is_partial := COALESCE((p_response->>'is_partial')::BOOLEAN, false);

  SELECT document.project_id INTO v_document_project_id
  FROM public.documents AS document
  WHERE document.id = v_document_id
  FOR UPDATE;

  IF v_document_project_id IS NULL
     OR v_document_project_id IS DISTINCT FROM v_project_id THEN
    RAISE EXCEPTION 'LLM response document does not belong to project';
  END IF;

  DELETE FROM public.auto_review_reconciliation_requests AS request
  WHERE request.document_id = v_document_id;

  UPDATE public.responses AS response
  SET is_latest = false
  WHERE response.project_id = v_project_id
    AND response.document_id = v_document_id
    AND response.respondent_type = 'llm'
    AND response.is_latest = true;

  INSERT INTO public.responses (
    project_id,
    document_id,
    respondent_id,
    respondent_type,
    respondent_name,
    answers,
    justifications,
    is_latest,
    is_partial,
    pydantic_hash,
    answer_field_hashes,
    llm_job_id,
    llm_error,
    schema_version_major,
    schema_version_minor,
    schema_version_patch,
    version_inferred_from,
    round_id
  ) VALUES (
    v_project_id,
    v_document_id,
    NULL,
    'llm',
    p_response->>'respondent_name',
    COALESCE(p_response->'answers', '{}'::JSONB),
    NULLIF(p_response->'justifications', 'null'::JSONB),
    NOT v_is_partial,
    v_is_partial,
    p_response->>'pydantic_hash',
    NULLIF(p_response->'answer_field_hashes', 'null'::JSONB),
    NULLIF(p_response->>'llm_job_id', '')::UUID,
    p_response->>'llm_error',
    COALESCE((p_response->>'schema_version_major')::INTEGER, 0),
    COALESCE((p_response->>'schema_version_minor')::INTEGER, 1),
    COALESCE((p_response->>'schema_version_patch')::INTEGER, 0),
    p_response->>'version_inferred_from',
    NULLIF(p_response->>'round_id', '')::UUID
  )
  RETURNING id INTO v_response_id;

  RETURN v_response_id;
END;
$$;

REVOKE ALL ON FUNCTION public.publish_latest_llm_response(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_latest_llm_response(JSONB)
  TO service_role;

CREATE OR REPLACE FUNCTION public.auto_review_reconciliation_capability()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION public.auto_review_reconciliation_capability()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_review_reconciliation_capability()
  TO service_role;

CREATE OR REPLACE FUNCTION public.record_auto_review_reconciliation_failure(
  p_document_id UUID,
  p_llm_response_id UUID,
  p_error TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.auto_review_reconciliation_requests AS request
  SET attempt_count = request.attempt_count + 1,
      last_error = pg_catalog.left(p_error, 4000),
      next_attempt_at = pg_catalog.now() + pg_catalog.make_interval(
        secs => LEAST(
          3600,
          (5 * pg_catalog.power(2, LEAST(request.attempt_count, 10)))::INTEGER
        )
      )
  WHERE request.document_id = p_document_id
    AND request.llm_response_id IS NOT DISTINCT FROM p_llm_response_id;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.record_auto_review_reconciliation_failure(UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_auto_review_reconciliation_failure(UUID, UUID, TEXT)
  TO service_role;

CREATE OR REPLACE FUNCTION public.enqueue_auto_review_reconciliation_for_project(
  p_project_id UUID
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_enqueued INTEGER;
BEGIN
  -- Share the same per-document publication mutex used by the response trigger
  -- and publish_latest_llm_response. The repair action cannot enqueue a stale
  -- LLM generation while a rerun is being published.
  PERFORM 1
  FROM public.documents AS document
  WHERE document.project_id = p_project_id
  ORDER BY document.id
  FOR UPDATE;

  INSERT INTO public.auto_review_reconciliation_requests (
    document_id, project_id, llm_response_id, allow_new_cycles
  )
  SELECT
    document.id,
    document.project_id,
    llm.id,
    project.automation_mode = 'auto_review_llm'
  FROM public.documents AS document
  JOIN public.projects AS project ON project.id = document.project_id
  LEFT JOIN LATERAL (
    SELECT response.id
    FROM public.responses AS response
    WHERE response.project_id = document.project_id
      AND response.document_id = document.id
      AND response.respondent_type = 'llm'
      AND response.is_latest = true
      AND response.is_partial = false
    LIMIT 1
  ) AS llm ON true
  WHERE document.project_id = p_project_id
    AND EXISTS (
      SELECT 1
      FROM public.responses AS human
      WHERE human.project_id = document.project_id
        AND human.document_id = document.id
        AND human.respondent_type = 'humano'
        AND human.is_latest = true
        AND human.is_partial = false
    )
    AND (
      project.automation_mode = 'auto_review_llm'
      OR EXISTS (
        SELECT 1 FROM public.field_reviews AS review
        WHERE review.project_id = document.project_id
          AND review.document_id = document.id
      )
      OR EXISTS (
        SELECT 1 FROM public.field_review_cycle_history_entries AS history
        WHERE history.project_id = document.project_id
          AND history.document_id = document.id
      )
    )
  ON CONFLICT (document_id) DO UPDATE
  SET project_id = EXCLUDED.project_id,
      llm_response_id = EXCLUDED.llm_response_id,
      allow_new_cycles = EXCLUDED.allow_new_cycles,
      requested_at = pg_catalog.now(),
      next_attempt_at = pg_catalog.now(),
      attempt_count = 0,
      last_error = NULL;

  GET DIAGNOSTICS v_enqueued = ROW_COUNT;
  RETURN v_enqueued;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_auto_review_reconciliation_for_project(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_auto_review_reconciliation_for_project(UUID)
  TO service_role;

-- Existing current LLM responses predate the INSERT trigger. Queue every
-- eligible document once so the rollout does not depend on a future rerun.
INSERT INTO public.auto_review_reconciliation_requests (
  document_id, project_id, llm_response_id, allow_new_cycles
)
SELECT
  llm.document_id,
  llm.project_id,
  llm.id,
  project.automation_mode = 'auto_review_llm'
FROM public.responses AS llm
JOIN public.projects AS project ON project.id = llm.project_id
WHERE llm.respondent_type = 'llm'
  AND llm.is_latest = true
  AND llm.is_partial = false
  AND (
    project.automation_mode = 'auto_review_llm'
    OR EXISTS (
      SELECT 1 FROM public.field_reviews AS review
      WHERE review.project_id = llm.project_id
        AND review.document_id = llm.document_id
    )
    OR EXISTS (
      SELECT 1 FROM public.field_review_cycle_history_entries AS history
      WHERE history.project_id = llm.project_id
        AND history.document_id = llm.document_id
    )
  )
ON CONFLICT (document_id) DO UPDATE
SET llm_response_id = EXCLUDED.llm_response_id,
    allow_new_cycles = EXCLUDED.allow_new_cycles,
    requested_at = pg_catalog.now(),
    next_attempt_at = pg_catalog.now(),
    attempt_count = 0,
    last_error = NULL;

CREATE OR REPLACE FUNCTION public.snapshot_response_equivalence_answers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_a public.responses%ROWTYPE;
  v_b public.responses%ROWTYPE;
BEGIN
  SELECT * INTO v_a
  FROM public.responses
  WHERE id = NEW.response_a_id;

  SELECT * INTO v_b
  FROM public.responses
  WHERE id = NEW.response_b_id;

  IF v_a.id IS NULL OR v_b.id IS NULL
     OR v_a.project_id IS DISTINCT FROM NEW.project_id
     OR v_b.project_id IS DISTINCT FROM NEW.project_id
     OR v_a.document_id IS DISTINCT FROM NEW.document_id
     OR v_b.document_id IS DISTINCT FROM NEW.document_id THEN
    RAISE EXCEPTION 'equivalence responses must belong to the declared project and document';
  END IF;

  NEW.response_a_answer_snapshot := v_a.answers -> NEW.field_name;
  NEW.response_b_answer_snapshot := v_b.answers -> NEW.field_name;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.snapshot_response_equivalence_answers()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER snapshot_response_equivalence_answers
BEFORE INSERT ON public.response_equivalences
FOR EACH ROW EXECUTE FUNCTION public.snapshot_response_equivalence_answers();

CREATE OR REPLACE FUNCTION public.record_response_equivalences(p_rows JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_inserted INTEGER;
BEGIN
  IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'p_rows must be a JSON array';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      documents.project_id || ':' || documents.document_id,
      0
    )
  )
  FROM (
    SELECT DISTINCT
      item->>'project_id' AS project_id,
      item->>'document_id' AS document_id
    FROM pg_catalog.jsonb_array_elements(p_rows) AS rows(item)
    ORDER BY project_id, document_id
  ) AS documents;

  IF SESSION_USER <> 'postgres'
     AND auth.role() IS DISTINCT FROM 'service_role'
     AND EXISTS (
       SELECT 1
       FROM pg_catalog.jsonb_array_elements(p_rows) AS rows(row)
       WHERE NOT (
         (
           (row->>'reviewer_id')::UUID IN (
             SELECT public.auth_user_member_identity_ids(
               (row->>'project_id')::UUID
             )
           )
           AND (row->>'project_id')::UUID IN (
             SELECT public.auth_user_accessible_project_ids()
           )
         )
         OR (row->>'project_id')::UUID IN (
           SELECT public.auth_user_coordinator_project_ids()
         )
         OR (row->>'project_id')::UUID IN (
           SELECT project.id
           FROM public.projects AS project
           WHERE project.created_by = public.clerk_uid()
         )
         OR public.is_master()
       )
     ) THEN
    RAISE EXCEPTION 'not allowed to record equivalences for this reviewer/project';
  END IF;

  -- A previous decision for the same response IDs may refer to older mutable
  -- values. DELETE is the single archive boundary for operational rows.
  DELETE FROM public.response_equivalences AS equivalence
  USING pg_catalog.jsonb_array_elements(p_rows) AS rows(row),
        public.responses AS response_a,
        public.responses AS response_b
  WHERE equivalence.project_id = (row->>'project_id')::UUID
    AND equivalence.document_id = (row->>'document_id')::UUID
    AND equivalence.field_name = row->>'field_name'
    AND equivalence.response_a_id = (row->>'response_a_id')::UUID
    AND equivalence.response_b_id = (row->>'response_b_id')::UUID
    AND response_a.id = equivalence.response_a_id
    AND response_b.id = equivalence.response_b_id
    AND (
      equivalence.response_a_answer_snapshot IS DISTINCT FROM
        response_a.answers -> equivalence.field_name
      OR equivalence.response_b_answer_snapshot IS DISTINCT FROM
        response_b.answers -> equivalence.field_name
    );

  WITH inserted AS (
    INSERT INTO public.response_equivalences (
      project_id,
      document_id,
      field_name,
      response_a_id,
      response_b_id,
      reviewer_id
    )
    SELECT
      (row->>'project_id')::UUID,
      (row->>'document_id')::UUID,
      row->>'field_name',
      (row->>'response_a_id')::UUID,
      (row->>'response_b_id')::UUID,
      (row->>'reviewer_id')::UUID
    FROM pg_catalog.jsonb_array_elements(p_rows) AS rows(row)
    ON CONFLICT (
      project_id,
      document_id,
      field_name,
      response_a_id,
      response_b_id
    ) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::INTEGER INTO v_inserted FROM inserted;

  RETURN v_inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.record_response_equivalences(JSONB)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_response_equivalences(JSONB)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.remove_response_equivalence(
  p_project_id UUID,
  p_equivalence_id UUID
) RETURNS TABLE(document_id UUID, field_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_document_id UUID;
  v_field_name TEXT;
BEGIN
  SELECT equivalence.document_id
  INTO v_document_id
  FROM public.response_equivalences AS equivalence
  WHERE equivalence.id = p_equivalence_id
    AND equivalence.project_id = p_project_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_project_id::TEXT || ':' || v_document_id::TEXT,
      0
    )
  );

  SELECT equivalence.document_id, equivalence.field_name
  INTO v_document_id, v_field_name
  FROM public.response_equivalences AS equivalence
  WHERE equivalence.id = p_equivalence_id
    AND equivalence.project_id = p_project_id
    AND (
      equivalence.reviewer_id = public.clerk_uid()
      OR equivalence.project_id IN (
        SELECT public.auth_user_coordinator_project_ids()
      )
      OR equivalence.project_id IN (
        SELECT project.id
        FROM public.projects AS project
        WHERE project.created_by = public.clerk_uid()
      )
      OR public.is_master()
    )
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE public.response_equivalences AS equivalence
  SET superseded_at = pg_catalog.now(),
      superseded_reason = 'manually_removed'
  WHERE equivalence.id = p_equivalence_id;

  DELETE FROM public.response_equivalences AS equivalence
  WHERE equivalence.id = p_equivalence_id;

  RETURN QUERY SELECT v_document_id, v_field_name;
END;
$$;

REVOKE ALL ON FUNCTION public.remove_response_equivalence(UUID, UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_response_equivalence(UUID, UUID)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.submit_auto_review_verdicts(
  p_project_id UUID,
  p_document_id UUID,
  p_reviewer_id UUID,
  p_rows JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row JSONB;
  v_review public.field_reviews%ROWTYPE;
  v_verdict TEXT;
  v_justification TEXT;
  v_contested_ids UUID[] := ARRAY[]::UUID[];
  v_arbitrator_id UUID;
  v_arbitrated INTEGER := 0;
BEGIN
  IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array'
     OR pg_catalog.jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'p_rows must be a non-empty JSON array';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_project_id::TEXT || ':' || p_document_id::TEXT,
      0
    )
  );

  IF (SELECT count(*) FROM pg_catalog.jsonb_array_elements(p_rows)) <>
     (SELECT count(DISTINCT row->>'field_review_id')
      FROM pg_catalog.jsonb_array_elements(p_rows) AS rows(row)) THEN
    RAISE EXCEPTION 'field_review_id must be unique within p_rows';
  END IF;

  FOR v_row IN SELECT row FROM pg_catalog.jsonb_array_elements(p_rows) AS rows(row)
  LOOP
    SELECT * INTO v_review
    FROM public.field_reviews AS review
    WHERE review.id = (v_row->>'field_review_id')::UUID
      AND review.project_id = p_project_id
      AND review.document_id = p_document_id
      AND review.field_name = v_row->>'field_name'
      AND review.self_reviewer_id = p_reviewer_id
      AND review.superseded_at IS NULL
    FOR UPDATE;

    IF v_review.id IS NULL THEN
      RAISE EXCEPTION 'review cycle is missing, superseded, or incompatible';
    END IF;

    v_verdict := v_row->>'verdict';
    v_justification := NULLIF(pg_catalog.btrim(v_row->>'justification'), '');
    IF v_verdict NOT IN ('admite_erro', 'contesta_llm', 'equivalente', 'ambiguo')
       OR (v_verdict IN ('contesta_llm', 'ambiguo') AND v_justification IS NULL)
       OR (v_review.self_verdict IS NOT NULL AND v_review.self_verdict <> v_verdict) THEN
      RAISE EXCEPTION 'invalid or conflicting self-review verdict';
    END IF;

    IF v_review.self_verdict IS NULL THEN
      UPDATE public.field_reviews
      SET self_verdict = v_verdict,
          self_reviewed_at = pg_catalog.now(),
          self_justification = CASE
            WHEN v_verdict IN ('contesta_llm', 'ambiguo') THEN v_justification
            ELSE NULL
          END
      WHERE id = v_review.id;
    END IF;

    IF v_verdict = 'equivalente' THEN
      INSERT INTO public.response_equivalences (
        project_id, document_id, field_name,
        response_a_id, response_b_id, reviewer_id
      ) VALUES (
        p_project_id, p_document_id, v_review.field_name,
        LEAST(v_review.human_response_id, v_review.llm_response_id),
        GREATEST(v_review.human_response_id, v_review.llm_response_id),
        p_reviewer_id
      ) ON CONFLICT (
        project_id, document_id, field_name, response_a_id, response_b_id
      ) DO NOTHING;
    ELSIF v_verdict = 'ambiguo' THEN
      IF NULLIF(v_row->>'comment_body', '') IS NULL THEN
        RAISE EXCEPTION 'ambiguity comment body is required';
      END IF;
      INSERT INTO public.project_comments (
        project_id, document_id, field_name, field_review_id, author_id, body
      ) VALUES (
        p_project_id, p_document_id, v_review.field_name, v_review.id,
        p_reviewer_id, v_row->>'comment_body'
      ) ON CONFLICT DO NOTHING;
    ELSIF v_verdict = 'contesta_llm' AND v_review.arbitrator_id IS NULL THEN
      v_contested_ids := pg_catalog.array_append(v_contested_ids, v_review.id);
    END IF;
  END LOOP;

  IF pg_catalog.cardinality(v_contested_ids) > 0 THEN
    SELECT member.user_id INTO v_arbitrator_id
    FROM public.project_members AS member
    WHERE member.project_id = p_project_id
      AND member.can_arbitrate = true
      AND member.user_id <> p_reviewer_id
    ORDER BY
      EXISTS (
        SELECT 1 FROM public.responses AS coder
        WHERE coder.project_id = p_project_id
          AND coder.document_id = p_document_id
          AND coder.respondent_type = 'humano'
          AND coder.respondent_id = member.user_id
      ),
      (SELECT count(*) FROM public.assignments AS open_assignment
       WHERE open_assignment.project_id = p_project_id
         AND open_assignment.user_id = member.user_id
         AND open_assignment.type = 'arbitragem'
         AND open_assignment.status <> 'concluido'),
      CASE WHEN member.role = 'pesquisador' THEN 0 ELSE 1 END,
      pg_catalog.random()
    LIMIT 1
    FOR UPDATE OF member;

    IF v_arbitrator_id IS NOT NULL THEN
      UPDATE public.field_reviews
      SET arbitrator_id = v_arbitrator_id
      WHERE id = ANY(v_contested_ids) AND arbitrator_id IS NULL;
      GET DIAGNOSTICS v_arbitrated = ROW_COUNT;

      IF v_arbitrated > 0 THEN
        INSERT INTO public.assignments (
          project_id, document_id, user_id, type, status
        ) VALUES (
          p_project_id, p_document_id, v_arbitrator_id, 'arbitragem', 'pendente'
        ) ON CONFLICT (document_id, user_id, type) DO NOTHING;
      END IF;
    END IF;
  END IF;

  UPDATE public.assignments AS assignment
  SET status = 'concluido', completed_at = pg_catalog.now()
  WHERE assignment.project_id = p_project_id
    AND assignment.document_id = p_document_id
    AND assignment.user_id = p_reviewer_id
    AND assignment.type = 'auto_revisao'
    AND NOT EXISTS (
      SELECT 1 FROM public.field_reviews AS review
      WHERE review.project_id = p_project_id
        AND review.document_id = p_document_id
        AND review.self_reviewer_id = p_reviewer_id
        AND review.self_verdict IS NULL
    );

  RETURN pg_catalog.jsonb_build_object(
    'arbitrated', v_arbitrated,
    'no_pool', pg_catalog.cardinality(v_contested_ids) > 0
      AND v_arbitrator_id IS NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.submit_auto_review_verdicts(UUID, UUID, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_auto_review_verdicts(UUID, UUID, UUID, JSONB)
  TO service_role;

CREATE OR REPLACE FUNCTION public.submit_final_review_verdicts(
  p_project_id UUID,
  p_document_id UUID,
  p_arbitrator_id UUID,
  p_rows JSONB
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row JSONB;
  v_review public.field_reviews%ROWTYPE;
  v_verdict TEXT;
  v_count INTEGER := 0;
BEGIN
  IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array'
     OR pg_catalog.jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'p_rows must be a non-empty JSON array';
  END IF;

  FOR v_row IN SELECT row FROM pg_catalog.jsonb_array_elements(p_rows) AS rows(row)
  LOOP
    SELECT * INTO v_review
    FROM public.field_reviews AS review
    WHERE review.id = (v_row->>'field_review_id')::UUID
      AND review.project_id = p_project_id
      AND review.document_id = p_document_id
      AND review.field_name = v_row->>'field_name'
      AND review.arbitrator_id = p_arbitrator_id
      AND review.superseded_at IS NULL
    FOR UPDATE;

    v_verdict := v_row->>'verdict';
    IF v_review.id IS NULL OR v_review.blind_verdict IS NULL
       OR v_verdict NOT IN ('humano', 'llm')
       OR (v_review.final_verdict IS NOT NULL AND v_review.final_verdict <> v_verdict)
       OR (v_verdict = 'llm' AND NULLIF(
         pg_catalog.btrim(v_row->>'question_improvement_suggestion'), ''
       ) IS NULL) THEN
      RAISE EXCEPTION 'invalid or conflicting final review verdict';
    END IF;

    IF v_review.final_verdict IS NULL THEN
      UPDATE public.field_reviews
      SET final_verdict = v_verdict,
          final_decided_at = pg_catalog.now(),
          question_improvement_suggestion =
            NULLIF(v_row->>'question_improvement_suggestion', ''),
          arbitrator_comment = NULLIF(v_row->>'arbitrator_comment', '')
      WHERE id = v_review.id;
      v_count := v_count + 1;
    END IF;

    IF v_verdict = 'llm' THEN
      IF NULLIF(v_row->>'comment_body', '') IS NULL THEN
        RAISE EXCEPTION 'final divergence comment body is required';
      END IF;
      INSERT INTO public.project_comments (
        project_id, document_id, field_name, field_review_id, author_id, body
      ) VALUES (
        p_project_id, p_document_id, v_review.field_name, v_review.id,
        p_arbitrator_id, v_row->>'comment_body'
      ) ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;

  UPDATE public.assignments AS assignment
  SET status = 'concluido', completed_at = pg_catalog.now()
  WHERE assignment.project_id = p_project_id
    AND assignment.document_id = p_document_id
    AND assignment.user_id = p_arbitrator_id
    AND assignment.type = 'arbitragem'
    AND NOT EXISTS (
      SELECT 1 FROM public.field_reviews AS review
      WHERE review.project_id = p_project_id
        AND review.document_id = p_document_id
        AND review.arbitrator_id = p_arbitrator_id
        AND review.final_verdict IS NULL
    );

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_final_review_verdicts(UUID, UUID, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_final_review_verdicts(UUID, UUID, UUID, JSONB)
  TO service_role;

-- One canonical producer for both inline submission and manual backlog repair.
-- Each group has this shape:
-- {
--   "human_response_id": "uuid",
--   "llm_response_id": "uuid",
--   "field_names": ["all", "current", "schema", "fields"],
--   "divergent_field_names": ["only", "divergent", "fields"]
-- }
-- The database derives project/document/reviewer and snapshots from the two
-- response rows; callers cannot construct cross-project review rows.
CREATE OR REPLACE FUNCTION public.reconcile_auto_review_cycles(
  p_groups JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_group JSONB;
  v_human public.responses%ROWTYPE;
  v_llm public.responses%ROWTYPE;
  v_field_names TEXT[];
  v_divergent TEXT[];
  v_created INTEGER := 0;
  v_superseded INTEGER := 0;
  v_unchanged INTEGER := 0;
  v_count INTEGER;
  v_created_in_group INTEGER;
  v_current_equivalence_ids JSONB;
  v_project_pydantic_hash TEXT;
BEGIN
  IF p_groups IS NULL OR pg_catalog.jsonb_typeof(p_groups) <> 'array' THEN
    RAISE EXCEPTION 'p_groups must be a JSON array';
  END IF;

  FOR v_group IN
    SELECT item
    FROM pg_catalog.jsonb_array_elements(p_groups) AS items(item)
    ORDER BY item->>'human_response_id', item->>'llm_response_id'
  LOOP
    v_created_in_group := 0;

    SELECT * INTO v_human
    FROM public.responses
    WHERE id = (v_group->>'human_response_id')::UUID
    FOR UPDATE;

    SELECT * INTO v_llm
    FROM public.responses
    WHERE id = (v_group->>'llm_response_id')::UUID
    FOR UPDATE;

    IF v_human.id IS NULL
       OR v_llm.id IS NULL
       OR v_human.respondent_type <> 'humano'
       OR v_llm.respondent_type <> 'llm'
       OR v_human.respondent_id IS NULL
       OR v_human.is_latest IS DISTINCT FROM true
       OR v_llm.is_latest IS DISTINCT FROM true
       OR v_human.project_id IS DISTINCT FROM v_llm.project_id
       OR v_human.document_id IS DISTINCT FROM v_llm.document_id THEN
      RAISE EXCEPTION 'auto-review responses must be current human/LLM rows from the same project and document';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        v_human.project_id::TEXT || ':' || v_human.document_id::TEXT,
        0
      )
    );

    SELECT COALESCE(pg_catalog.array_agg(DISTINCT name ORDER BY name), ARRAY[]::TEXT[])
    INTO v_field_names
    FROM pg_catalog.jsonb_array_elements_text(
      COALESCE(v_group->'field_names', '[]'::JSONB)
    ) AS names(name);

    SELECT COALESCE(pg_catalog.array_agg(DISTINCT name ORDER BY name), ARRAY[]::TEXT[])
    INTO v_divergent
    FROM pg_catalog.jsonb_array_elements_text(
      COALESCE(v_group->'divergent_field_names', '[]'::JSONB)
    ) AS names(name);

    IF EXISTS (
      SELECT 1 FROM pg_catalog.unnest(v_divergent) AS divergent(name)
      WHERE NOT (divergent.name = ANY(v_field_names))
    ) THEN
      RAISE EXCEPTION 'divergent fields must be a subset of field_names';
    END IF;

    IF NOT (
      v_group ? 'expected_human_updated_at'
      AND v_group ? 'expected_llm_updated_at'
      AND v_group ? 'expected_project_pydantic_hash'
      AND v_group ? 'expected_equivalence_ids'
    ) THEN
      RAISE EXCEPTION 'auto-review reconciliation requires versioned inputs';
    END IF;

    SELECT project.pydantic_hash INTO v_project_pydantic_hash
    FROM public.projects AS project
    WHERE project.id = v_human.project_id;

    SELECT COALESCE(
      pg_catalog.jsonb_agg(locked.id::TEXT ORDER BY locked.id),
      '[]'::JSONB
    )
    INTO v_current_equivalence_ids
    FROM (
      SELECT equivalence.id
      FROM public.response_equivalences AS equivalence
      WHERE equivalence.project_id = v_human.project_id
        AND equivalence.document_id = v_human.document_id
        AND equivalence.field_name = ANY(v_field_names)
        AND equivalence.superseded_at IS NULL
        AND (
          (
            equivalence.response_a_id = v_human.id
            AND equivalence.response_b_id = v_llm.id
          )
          OR (
            equivalence.response_a_id = v_llm.id
            AND equivalence.response_b_id = v_human.id
          )
        )
      ORDER BY equivalence.id
      FOR SHARE
    ) AS locked;

    IF v_human.updated_at IS DISTINCT FROM
         (v_group->>'expected_human_updated_at')::TIMESTAMPTZ
       OR v_llm.updated_at IS DISTINCT FROM
         (v_group->>'expected_llm_updated_at')::TIMESTAMPTZ
       OR v_project_pydantic_hash IS DISTINCT FROM
         v_group->>'expected_project_pydantic_hash'
       OR v_current_equivalence_ids IS DISTINCT FROM
         COALESCE(v_group->'expected_equivalence_ids', '[]'::JSONB) THEN
      RAISE EXCEPTION 'auto-review reconciliation inputs changed; retry required';
    END IF;

    DELETE FROM public.response_equivalences AS equivalence
    WHERE equivalence.project_id = v_human.project_id
      AND equivalence.document_id = v_human.document_id
      AND (
        (
          equivalence.response_a_id = v_human.id
          AND equivalence.response_a_answer_snapshot IS DISTINCT FROM
            v_human.answers -> equivalence.field_name
        )
        OR (
          equivalence.response_b_id = v_human.id
          AND equivalence.response_b_answer_snapshot IS DISTINCT FROM
            v_human.answers -> equivalence.field_name
        )
        OR (
          equivalence.response_a_id = v_llm.id
          AND equivalence.response_a_answer_snapshot IS DISTINCT FROM
            v_llm.answers -> equivalence.field_name
        )
        OR (
          equivalence.response_b_id = v_llm.id
          AND equivalence.response_b_answer_snapshot IS DISTINCT FROM
            v_llm.answers -> equivalence.field_name
        )
      );

    WITH changed AS (
      UPDATE public.field_reviews AS review
      SET superseded_at = pg_catalog.now(),
          superseded_reason = CASE
            WHEN NOT (review.field_name = ANY(v_divergent))
            THEN 'no_longer_divergent'
            WHEN review.human_response_id <> v_human.id
              OR review.human_answer_snapshot IS DISTINCT FROM
                 v_human.answers -> review.field_name
            THEN 'answer_changed'
            ELSE 'llm_changed'
          END
      WHERE review.project_id = v_human.project_id
        AND review.document_id = v_human.document_id
        AND review.self_reviewer_id = v_human.respondent_id
        AND review.superseded_at IS NULL
        AND (
          NOT (review.field_name = ANY(v_divergent))
          OR review.human_response_id <> v_human.id
          OR review.llm_response_id <> v_llm.id
          OR review.human_answer_snapshot IS DISTINCT FROM
             v_human.answers -> review.field_name
          OR review.llm_answer_snapshot IS DISTINCT FROM
             v_llm.answers -> review.field_name
          OR review.llm_justification_snapshot IS DISTINCT FROM
             v_llm.justifications -> review.field_name
        )
      RETURNING 1
    )
    SELECT count(*)::INTEGER INTO v_count FROM changed;
    v_superseded := v_superseded + v_count;

    INSERT INTO public.field_review_cycle_history_entries
    SELECT review.*
    FROM public.field_reviews AS review
    WHERE review.project_id = v_human.project_id
      AND review.document_id = v_human.document_id
      AND review.self_reviewer_id = v_human.respondent_id
      AND review.superseded_at IS NOT NULL
      AND review.field_name = ANY(v_divergent)
    ON CONFLICT (id) DO NOTHING;

    DELETE FROM public.field_reviews AS review
    WHERE review.project_id = v_human.project_id
      AND review.document_id = v_human.document_id
      AND review.self_reviewer_id = v_human.respondent_id
      AND review.superseded_at IS NOT NULL
      AND NOT (review.field_name = ANY(v_divergent));

    UPDATE public.field_reviews AS review
    SET id = pg_catalog.gen_random_uuid(),
        human_response_id = v_human.id,
        llm_response_id = v_llm.id,
        cycle_no = review.cycle_no + 1,
        human_answer_snapshot = v_human.answers -> review.field_name,
        llm_answer_snapshot = v_llm.answers -> review.field_name,
        llm_justification_snapshot = v_llm.justifications -> review.field_name,
        snapshot_reliable = true,
        self_verdict = NULL,
        self_reviewed_at = NULL,
        self_justification = NULL,
        arbitrator_id = NULL,
        blind_verdict = NULL,
        blind_decided_at = NULL,
        final_verdict = NULL,
        final_decided_at = NULL,
        question_improvement_suggestion = NULL,
        arbitrator_comment = NULL,
        created_at = pg_catalog.now(),
        superseded_at = NULL,
        superseded_reason = NULL
    WHERE review.project_id = v_human.project_id
      AND review.document_id = v_human.document_id
      AND review.self_reviewer_id = v_human.respondent_id
      AND review.superseded_at IS NOT NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_created_in_group := v_created_in_group + v_count;
    v_created := v_created + v_count;

    WITH candidates AS (
      SELECT field_name
      FROM pg_catalog.unnest(v_divergent) AS fields(field_name)
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.field_reviews AS current_review
        WHERE current_review.document_id = v_human.document_id
          AND current_review.field_name = fields.field_name
          AND current_review.superseded_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.field_reviews AS first_review
        WHERE first_review.document_id = v_human.document_id
          AND first_review.field_name = fields.field_name
          AND first_review.self_reviewer_id <> v_human.respondent_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.field_review_cycle_history_entries AS first_review
        WHERE first_review.document_id = v_human.document_id
          AND first_review.field_name = fields.field_name
          AND first_review.self_reviewer_id <> v_human.respondent_id
          AND NOT EXISTS (
            SELECT 1
            FROM public.member_email_links AS alias
            WHERE alias.project_id = v_human.project_id
              AND alias.member_user_id = v_human.respondent_id
              AND alias.linked_user_id = first_review.self_reviewer_id
          )
      )
    ), inserted AS (
      INSERT INTO public.field_reviews (
        project_id,
        document_id,
        field_name,
        human_response_id,
        llm_response_id,
        self_reviewer_id
      )
      SELECT
        v_human.project_id,
        v_human.document_id,
        candidate.field_name,
        v_human.id,
        v_llm.id,
        v_human.respondent_id
      FROM candidates AS candidate
      ON CONFLICT (document_id, field_name) DO NOTHING
      RETURNING 1
    )
    SELECT count(*)::INTEGER INTO v_count FROM inserted;
    v_created_in_group := v_created_in_group + v_count;
    v_created := v_created + v_count;

    SELECT count(*)::INTEGER INTO v_count
    FROM public.field_reviews AS review
    WHERE review.project_id = v_human.project_id
      AND review.document_id = v_human.document_id
      AND review.self_reviewer_id = v_human.respondent_id
      AND review.superseded_at IS NULL
      AND review.field_name = ANY(v_divergent);
    v_unchanged := v_unchanged + GREATEST(v_count - v_created_in_group, 0);

    -- Temporary compatibility projection for the frontend deployed before this
    -- migration.  The cycle-aware frontend does not read this assignment.
    INSERT INTO public.assignments (
      project_id, document_id, user_id, type, status
    )
    SELECT
      v_human.project_id,
      v_human.document_id,
      v_human.respondent_id,
      'auto_revisao',
      'pendente'
    WHERE EXISTS (
      SELECT 1
      FROM public.field_reviews AS review
      WHERE review.project_id = v_human.project_id
        AND review.document_id = v_human.document_id
        AND review.self_reviewer_id = v_human.respondent_id
        AND review.superseded_at IS NULL
        AND review.self_verdict IS NULL
    )
    ON CONFLICT (document_id, user_id, type) DO UPDATE
    SET status = 'pendente', completed_at = NULL;

    UPDATE public.assignments AS assignment
    SET status = 'concluido', completed_at = pg_catalog.now()
    WHERE assignment.project_id = v_human.project_id
      AND assignment.document_id = v_human.document_id
      AND assignment.user_id = v_human.respondent_id
      AND assignment.type = 'auto_revisao'
      AND NOT EXISTS (
        SELECT 1
        FROM public.field_reviews AS review
        WHERE review.project_id = assignment.project_id
          AND review.document_id = assignment.document_id
          AND review.self_reviewer_id = assignment.user_id
          AND review.superseded_at IS NULL
          AND review.self_verdict IS NULL
      );

    DELETE FROM public.assignments AS assignment
    WHERE assignment.project_id = v_human.project_id
      AND assignment.document_id = v_human.document_id
      AND assignment.type = 'arbitragem'
      AND assignment.status <> 'concluido'
      AND NOT EXISTS (
        SELECT 1
        FROM public.field_reviews AS review
        WHERE review.project_id = assignment.project_id
          AND review.document_id = assignment.document_id
          AND review.arbitrator_id = assignment.user_id
          AND review.superseded_at IS NULL
          AND review.final_verdict IS NULL
      );
  END LOOP;

  RETURN pg_catalog.jsonb_build_object(
    'created', v_created,
    'superseded', v_superseded,
    'unchanged', v_unchanged
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_auto_review_cycles(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_auto_review_cycles(JSONB)
  TO service_role;

-- Existing arbitration RPCs used document/field as if it still identified one
-- row. Once history exists, every operational mutation must explicitly target
-- the active cycle.
CREATE OR REPLACE FUNCTION public.assign_arbitration_cycles_if_eligible(
  p_project_id UUID,
  p_document_id UUID,
  p_user_id UUID,
  p_field_review_ids UUID[]
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_assigned INTEGER := 0;
BEGIN
  PERFORM 1
  FROM public.project_members AS member
  WHERE member.project_id = p_project_id
    AND member.user_id = p_user_id
    AND member.can_arbitrate = true
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  WITH assigned_reviews AS (
    UPDATE public.field_reviews AS review
    SET arbitrator_id = p_user_id
    WHERE review.project_id = p_project_id
      AND review.document_id = p_document_id
      AND review.id = ANY(p_field_review_ids)
      AND review.superseded_at IS NULL
      AND review.self_verdict = 'contesta_llm'
      AND review.arbitrator_id IS NULL
    RETURNING review.id
  )
  SELECT count(*)::INTEGER INTO v_assigned FROM assigned_reviews;

  IF v_assigned > 0 THEN
    INSERT INTO public.assignments (
      project_id, document_id, user_id, type, status
    ) VALUES (
      p_project_id, p_document_id, p_user_id, 'arbitragem', 'pendente'
    )
    ON CONFLICT (document_id, user_id, type) DO NOTHING;
  END IF;

  RETURN v_assigned;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_arbitration_cycles_if_eligible(
  UUID, UUID, UUID, UUID[]
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_arbitration_cycles_if_eligible(
  UUID, UUID, UUID, UUID[]
) TO service_role;

-- Compatibility wrapper for frontend instances deployed before cycle IDs were
-- added to the arbitration contract.
CREATE OR REPLACE FUNCTION public.assign_arbitration_if_eligible(
  p_project_id UUID,
  p_document_id UUID,
  p_user_id UUID,
  p_field_names TEXT[]
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_review_ids UUID[];
BEGIN
  SELECT pg_catalog.array_agg(review.id)
  INTO v_review_ids
  FROM public.field_reviews AS review
  WHERE review.project_id = p_project_id
    AND review.document_id = p_document_id
    AND review.field_name = ANY(p_field_names)
    AND review.superseded_at IS NULL
    AND review.self_verdict = 'contesta_llm'
    AND review.arbitrator_id IS NULL;

  IF v_review_ids IS NULL THEN
    RETURN 0;
  END IF;

  RETURN public.assign_arbitration_cycles_if_eligible(
    p_project_id,
    p_document_id,
    p_user_id,
    v_review_ids
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_member_arbitration_permission(
  p_member_id UUID,
  p_enabled BOOLEAN
) RETURNS TABLE(project_id UUID)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_project_id UUID;
  v_user_id UUID;
  v_document_ids UUID[];
BEGIN
  UPDATE public.project_members AS member
  SET can_arbitrate = p_enabled
  WHERE member.id = p_member_id
  RETURNING member.project_id, member.user_id
  INTO v_project_id, v_user_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF NOT p_enabled THEN
    WITH released_reviews AS (
      UPDATE public.field_reviews AS review
      SET arbitrator_id = NULL,
          blind_verdict = NULL,
          blind_decided_at = NULL
      WHERE review.project_id = v_project_id
        AND review.arbitrator_id = v_user_id
        AND review.superseded_at IS NULL
        AND review.self_verdict = 'contesta_llm'
        AND review.final_verdict IS NULL
      RETURNING review.document_id
    )
    SELECT pg_catalog.array_agg(DISTINCT released.document_id)
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

CREATE OR REPLACE VIEW public.auto_review_cycle_history
WITH (security_invoker = true) AS
SELECT
  review.id,
  review.project_id,
  review.document_id,
  review.field_name,
  review.self_reviewer_id,
  review.cycle_no,
  review.human_response_id,
  review.llm_response_id,
  review.human_answer_snapshot,
  review.llm_answer_snapshot,
  review.llm_justification_snapshot,
  review.snapshot_reliable,
  review.self_verdict,
  review.self_justification,
  review.self_reviewed_at,
  review.arbitrator_id,
  review.blind_verdict,
  review.blind_decided_at,
  review.final_verdict,
  review.final_decided_at,
  review.superseded_at,
  review.superseded_reason,
  review.created_at
FROM (
  SELECT current_review.*
  FROM public.field_reviews AS current_review
  UNION ALL
  SELECT historical_review.*
  FROM public.field_review_cycle_history_entries AS historical_review
) AS review;

REVOKE ALL ON public.auto_review_cycle_history FROM PUBLIC, anon;
GRANT SELECT ON public.field_review_cycle_history_entries
  TO authenticated, service_role;
GRANT SELECT ON public.auto_review_cycle_history TO authenticated, service_role;

CREATE OR REPLACE VIEW public.response_equivalence_history
WITH (security_invoker = true) AS
SELECT current_equivalence.*
FROM public.response_equivalences AS current_equivalence
UNION ALL
SELECT historical_equivalence.*
FROM public.response_equivalence_history_entries AS historical_equivalence;

REVOKE ALL ON public.response_equivalence_history FROM PUBLIC, anon;
GRANT SELECT ON public.response_equivalence_history_entries
  TO authenticated, service_role;
GRANT SELECT ON public.response_equivalence_history
  TO authenticated, service_role;

CREATE OR REPLACE VIEW public.final_answers
WITH (security_invoker = true) AS
SELECT
  r_llm.project_id,
  r_llm.document_id,
  fld.field_name,
  CASE
    WHEN reconciliation.pending THEN NULL
    WHEN fr.id IS NULL THEN r_llm.answers -> fld.field_name
    WHEN fr.self_verdict IS NULL THEN NULL
    WHEN fr.self_verdict = 'admite_erro' THEN fr.llm_answer_snapshot
    WHEN fr.self_verdict = 'equivalente' THEN fr.human_answer_snapshot
    WHEN fr.self_verdict = 'ambiguo' THEN NULL
    WHEN fr.final_verdict IS NULL THEN NULL
    WHEN fr.final_verdict = 'humano' THEN fr.human_answer_snapshot
    WHEN fr.final_verdict = 'llm' THEN fr.llm_answer_snapshot
    ELSE NULL
  END AS answer,
  CASE
    WHEN reconciliation.pending THEN 'aguarda_reconciliacao'
    WHEN fr.id IS NULL THEN 'consenso'
    WHEN fr.self_verdict IS NULL THEN 'aguarda_auto_revisao'
    WHEN fr.self_verdict = 'admite_erro' THEN 'auto_corrigido'
    WHEN fr.self_verdict = 'equivalente' THEN 'equivalente'
    WHEN fr.self_verdict = 'ambiguo' THEN 'ambiguo'
    WHEN fr.final_verdict IS NULL THEN 'aguarda_arbitragem'
    ELSE 'arbitrado'
  END AS provenance,
  fr.id AS field_review_id,
  fr.changed_after_justification,
  fr.cycle_no
FROM public.responses AS r_llm
JOIN public.projects AS project ON project.id = r_llm.project_id
CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
  COALESCE(project.pydantic_fields, '[]'::JSONB)
) AS field_raw
CROSS JOIN LATERAL (SELECT field_raw->>'name' AS field_name) AS fld
LEFT JOIN public.field_reviews AS fr
  ON fr.document_id = r_llm.document_id
  AND fr.field_name = fld.field_name
  AND fr.superseded_at IS NULL
CROSS JOIN LATERAL (
  SELECT public.is_auto_review_reconciliation_pending(
    r_llm.project_id, r_llm.document_id, r_llm.id
  ) AS pending
) AS reconciliation
WHERE r_llm.respondent_type = 'llm'
  AND r_llm.is_latest = true;

REVOKE SELECT ON public.final_answers FROM anon;
GRANT SELECT ON public.final_answers TO authenticated, service_role;

COMMIT;
