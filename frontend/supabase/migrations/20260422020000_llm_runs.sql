-- Persistent log of LLM runs (one row per job dispatched via POST /api/llm/run).
-- Today, job status lives only in the FastAPI process memory (_jobs dict in
-- backend/services/llm_runner.py). If the container restarts or the user
-- closes the tab, the error message is lost. This table captures every run
-- (completed and failed) so researchers/coordinators can review diagnostics
-- later.
--
-- Writes come exclusively from the backend (service-role key, bypasses RLS).
-- Reads are gated to project members via auth_user_project_ids().

CREATE TABLE llm_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  job_id          TEXT NOT NULL UNIQUE,
  started_by      UUID REFERENCES profiles(id),

  -- Config snapshot for diagnosis
  llm_provider    TEXT,
  llm_model       TEXT,
  filter_mode     TEXT,
  document_count  INT,
  pydantic_code   TEXT,

  -- Status
  status          TEXT NOT NULL CHECK (status IN ('running','completed','error')),
  phase           TEXT,
  progress        INT DEFAULT 0,
  total           INT DEFAULT 0,

  -- Error diagnostics (populated when status='error')
  error_message   TEXT,
  error_type      TEXT,
  error_traceback TEXT,
  error_line      INT,
  error_column    INT,
  dismissed_at    TIMESTAMPTZ,

  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_llm_runs_project_started ON llm_runs(project_id, started_at DESC);
CREATE INDEX idx_llm_runs_project_status ON llm_runs(project_id, status);

ALTER TABLE llm_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members view llm_runs" ON llm_runs FOR SELECT USING (
  project_id IN (SELECT auth_user_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
);

-- Coordinators (and project creators) can mark a failed run as "dismissed"
-- from the UI. Writes come through a Server Action using the Clerk JWT;
-- service-role inserts from the backend bypass RLS anyway.
CREATE POLICY "Coordinators update llm_runs" ON llm_runs FOR UPDATE USING (
  project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = clerk_uid())
);
