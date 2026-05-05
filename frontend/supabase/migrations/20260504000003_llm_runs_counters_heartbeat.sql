-- Persistir counters ao vivo e heartbeat em llm_runs.
--
-- Motivacao: o conjunto de mudancas deste PR introduz contadores
-- processed_complete/partial/empty exibidos ao vivo no LlmConfigurePane
-- (backend/services/llm_runner.py). Esses contadores nasceram vivendo
-- apenas no dict _jobs em memoria do backend; como o deploy roda
-- single-worker em Fly.io com min_machines_running=0 (scale-to-zero), toda
-- vez que a maquina hiberna ou reinicia esses contadores somem -- exatamente
-- a feature recem adicionada.
--
-- Alem disso, runs cuja maquina morreu antes de completar ficavam com
-- status='running' eternamente: o frontend nao tinha como distinguir uma
-- run viva de uma run zumbi e, com a feature de retomada de polling
-- (getRunningLlmJob), religava o card de execucao para sempre.
--
-- Esta migration adiciona:
--  - 3 colunas de contadores persistidos: o save loop atualiza esses
--    valores periodicamente (throttle 2s) e o frontend le dali quando o
--    fallback _status_from_row e acionado (caso o _jobs em memoria nao
--    tenha o job).
--  - heartbeat_at: timestamp atualizado pelo save loop no mesmo throttle.
--    Cleanup ativo (mark_stale_runs_as_error) marca como 'error' as runs
--    com heartbeat antigo, e getRunningLlmJob filtra por heartbeat recente.

ALTER TABLE llm_runs
  ADD COLUMN processed_complete INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN processed_partial INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN processed_empty INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN heartbeat_at TIMESTAMPTZ;
