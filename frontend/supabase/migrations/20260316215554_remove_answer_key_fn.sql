CREATE OR REPLACE FUNCTION remove_answer_key(
  p_project_id UUID,
  p_field_name TEXT
)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE responses
  SET answers = answers - p_field_name
  WHERE project_id = p_project_id
    AND respondent_type = 'humano';
$$;
