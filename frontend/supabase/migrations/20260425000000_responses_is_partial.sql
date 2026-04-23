-- Separa o sinal "resposta parcial" de "resposta superseded".
--
-- Motivo: is_current acumulava duas semânticas incompatíveis desde PR #65:
--   1) Resposta com cobertura baixa (is_partial no insert → is_current=false)
--   2) Resposta superseded por uma run posterior (bulk update em llm_runner.py)
-- O bulk update de (2) apaga a informação de (1), fazendo com que respostas
-- originalmente completas de runs antigas fossem contadas como "parciais" na
-- aba LLM / Execuções e LLM / Respostas sempre que uma segunda run rodava nos
-- mesmos documentos.
--
-- Agora:
--   is_current = mais recente e não-parcial (controla Comparar; pode mudar)
--   is_partial = cobertura baixa no momento do insert (IMUTÁVEL após insert)

ALTER TABLE responses
  ADD COLUMN is_partial BOOLEAN NOT NULL DEFAULT false;

-- Index para acelerar as queries de estatísticas por job (LlmRunsPane).
CREATE INDEX IF NOT EXISTS idx_responses_llm_job_is_partial
  ON responses (llm_job_id, is_partial)
  WHERE llm_job_id IS NOT NULL;
