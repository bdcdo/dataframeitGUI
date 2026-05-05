-- Index parcial em llm_runs(heartbeat_at) restrito a status='running'.
--
-- Motivacao: getRunningLlmJob (frontend/src/actions/llm.ts) filtra por
-- (project_id, status='running', heartbeat_at > cutoff). mark_stale_runs_as_error
-- (backend/services/llm_runner.py) filtra por (project_id, status='running',
-- heartbeat_at < cutoff OR null). Ambos sao chamados em mount do
-- LlmConfigurePane e podem rodar muitas vezes por dia. Sem index, full scan
-- em llm_runs cresce O(n) com o historico do projeto.
--
-- Index parcial (WHERE status='running') porque a vasta maioria das runs
-- termina como completed/error -- so vale indexar a fatia ativa, mantendo
-- o index pequeno e barato de manter.

CREATE INDEX IF NOT EXISTS idx_llm_runs_running_heartbeat
  ON llm_runs (project_id, heartbeat_at)
  WHERE status = 'running';
