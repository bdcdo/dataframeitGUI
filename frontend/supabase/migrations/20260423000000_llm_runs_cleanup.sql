-- Cleanup of llm_runs following PR #60 review.
--
-- - Drop `started_by` and `dismissed_at` columns: declared in the original
--   migration but never written anywhere in the code. No half-finished schema.
-- - Drop the UPDATE policy for coordinators: existed only to support the
--   unused `dismissed_at` write path.
-- - Drop the `(project_id, status)` index: no query filters by status.
-- - Add CHECK constraints on `filter_mode` and `phase` for parity with `status`.
-- - Convert `job_id` from TEXT to UUID: values are UUIDs (uuid.uuid4) and UUID
--   is cheaper to index.

DROP POLICY IF EXISTS "Coordinators update llm_runs" ON llm_runs;

DROP INDEX IF EXISTS idx_llm_runs_project_status;

ALTER TABLE llm_runs
  DROP COLUMN IF EXISTS started_by,
  DROP COLUMN IF EXISTS dismissed_at;

ALTER TABLE llm_runs
  ADD CONSTRAINT llm_runs_filter_mode_check
  CHECK (filter_mode IS NULL OR filter_mode IN ('all','pending','max_responses','random_sample'));

ALTER TABLE llm_runs
  ADD CONSTRAINT llm_runs_phase_check
  CHECK (phase IS NULL OR phase IN ('loading','processing','saving','completed','error'));

ALTER TABLE llm_runs
  ALTER COLUMN job_id TYPE UUID USING job_id::uuid;
