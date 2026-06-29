-- projects.automation_mode: modo de automação de revisão do projeto, escolhido
-- na criação e editável em Config › Regras. Mutuamente exclusivo — define qual
-- mecanismo dispara automaticamente e quais abas de revisão aparecem.
--
--   none            → nenhuma automação (tudo manual via LotteryDialog)
--   auto_review_llm → 1 codificador diverge do LLM → auto-revisão do próprio
--                     codificador → contestados viram arbitragem (comportamento
--                     EXISTENTE, antes incondicional em saveResponse)
--   compare_humans  → 2+ codificadores (>= min_responses_for_comparison) divergem
--                     → comparação por um revisor terceiro (can_compare)
--   compare_llm     → 1 codificador diverge do LLM → comparação por um revisor
--                     terceiro (can_compare), humano-vs-LLM
--
-- DEFAULT 'auto_review_llm' faz o backfill que preserva exatamente o
-- comportamento atual: até esta migration, createAutoReviewIfDiverges rodava em
-- todo projeto, sem config (actions/responses.ts). Sem esse default, os projetos
-- em produção parariam de auto-revisar ao aplicar a migration.

ALTER TABLE projects
  ADD COLUMN automation_mode TEXT NOT NULL DEFAULT 'auto_review_llm'
  CHECK (automation_mode IN ('none', 'auto_review_llm', 'compare_humans', 'compare_llm'));

-- comparison_includes_llm: no modo compare_humans, controla se a resposta do LLM
-- (quando existe) entra no cálculo de divergência que DISPARA a comparação.
--   true  → dispara quando, entre todas as respostas presentes (humanos + LLM),
--           houver divergência (humanos concordando mas LLM diferente já libera).
--   false → dispara só quando os humanos divergem entre si; o LLM ainda aparece
--           na tela de comparação, mas não decide o disparo.
-- Só afeta compare_humans; em compare_llm/auto_review_llm o LLM é intrínseco.
ALTER TABLE projects
  ADD COLUMN comparison_includes_llm BOOLEAN NOT NULL DEFAULT true;
