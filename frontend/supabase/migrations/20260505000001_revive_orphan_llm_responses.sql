-- Backfill: revive respostas LLM zeradas por schema bumps anteriores.
--
-- Contexto: até o commit que removeu o flip em saveSchema (PR #87), editar o
-- schema Pydantic disparava UPDATE responses SET is_current=false sempre que
-- o pydantic_hash do projeto mudava. Como LLM Insights, Compare e várias
-- outras telas filtram por is_current=true, todas as respostas LLM somem da
-- UI até uma nova run rodar — destruindo o contexto da revisão de erros que
-- motivou a edição do schema (caso real: projeto Zolgensma, 67 respostas).
--
-- Esta migration ressuscita apenas as respostas onde a "mais recente
-- não-parcial" por (project_id, document_id) está com is_current=false.
-- Quando há uma resposta is_current=true mais nova ela vence o DISTINCT ON e
-- o filtro nada faz — supersede legítimo (llm_runner.py:766) é preservado.
-- Respostas com is_partial=true não são tocadas: is_current=false é o estado
-- intencional para parciais (llm_runner.py:932-936).
--
-- Idempotente: rodar novamente é no-op.

UPDATE responses
SET is_current = true
WHERE id IN (
  SELECT DISTINCT ON (project_id, document_id) id
  FROM responses
  WHERE respondent_type = 'llm'
    AND is_partial = false
  ORDER BY project_id, document_id, created_at DESC
)
AND is_current = false
AND is_partial = false
AND respondent_type = 'llm';
