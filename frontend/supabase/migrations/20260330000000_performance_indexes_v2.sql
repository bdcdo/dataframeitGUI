-- Performance indexes v2: RLS hot-path + query-specific optimizations

-- Partial index for active responses (stats, compare, llm, export pages)
CREATE INDEX IF NOT EXISTS idx_responses_project_is_current
  ON responses(project_id) WHERE is_current = true;

-- RLS hot-path: every RLS policy checks "projects WHERE created_by = auth.uid()"
CREATE INDEX IF NOT EXISTS idx_projects_created_by
  ON projects(created_by);

-- Respondent lookup on code page (responses by project + user)
CREATE INDEX IF NOT EXISTS idx_responses_project_respondent
  ON responses(project_id, respondent_id);

-- Assignment status filtering (stats page counts completed assignments)
CREATE INDEX IF NOT EXISTS idx_assignments_project_status
  ON assignments(project_id, status);
