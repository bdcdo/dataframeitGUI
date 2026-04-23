-- Associa respostas LLM à execução (job) que as produziu.
-- Motivo: a aba LLM / Respostas precisa filtrar e agrupar respostas por run
-- para exibir quais ficaram parciais em cada rodada. Até aqui só existia
-- correlação implícita por (respondent_type='llm', created_at próximo de
-- llm_runs.started_at), o que é frágil quando duas runs se sobrepõem no tempo.
--
-- Escolhemos referenciar `llm_runs.job_id` (UUID público, já único) em vez de
-- `llm_runs.id` porque o backend passa `job_id` em todo o fluxo de execução
-- (ver run_llm em backend/services/llm_runner.py); não precisa ler o id do
-- insert em _persist_run_insert.

ALTER TABLE responses
  ADD COLUMN llm_job_id UUID;

CREATE INDEX IF NOT EXISTS idx_responses_llm_job_id
  ON responses (llm_job_id)
  WHERE llm_job_id IS NOT NULL;

-- Backfill best-effort: associa cada resposta LLM existente à run mais recente
-- do mesmo projeto cujo intervalo [started_at, completed_at+2h] cobre o
-- created_at da resposta. Runs sem completed_at ganham uma janela generosa de
-- 2h para cobrir execuções travadas/canceladas.
UPDATE responses r
SET llm_job_id = (
  SELECT lr.job_id
  FROM llm_runs lr
  WHERE lr.project_id = r.project_id
    AND r.created_at BETWEEN lr.started_at
      AND COALESCE(lr.completed_at, lr.started_at + INTERVAL '2 hours')
  ORDER BY lr.started_at DESC
  LIMIT 1
)
WHERE r.respondent_type = 'llm' AND r.llm_job_id IS NULL;
