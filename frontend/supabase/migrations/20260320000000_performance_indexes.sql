-- Performance: index on project_members(user_id) to speed up RLS policies
-- The auth_user_project_ids() function queries project_members by user_id on every RLS check.
-- Without this index, it does a sequential scan on every query.

CREATE INDEX IF NOT EXISTS idx_project_members_user_id
  ON project_members(user_id);

-- Also index responses(project_id, document_id) for the common query pattern
CREATE INDEX IF NOT EXISTS idx_responses_project_document
  ON responses(project_id, document_id);

-- Index assignments(project_id, user_id) for coding page lookups
CREATE INDEX IF NOT EXISTS idx_assignments_project_user
  ON assignments(project_id, user_id);
