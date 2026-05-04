-- Index composto para a query da aba Histórico do schema, que filtra por
-- project_id e ordena por created_at DESC. O index simples por project_id
-- (idx_schema_change_log_project) continua, pois pode ser usado por outros
-- caminhos que não precisam da ordenação.

CREATE INDEX IF NOT EXISTS idx_schema_change_log_project_created
  ON schema_change_log(project_id, created_at DESC);
