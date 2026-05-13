-- Documenta a semantica da constraint UNIQUE em field_reviews.
--
-- A chave (document_id, field_name) implica:
--   - 1 linha por par (doc, campo) globalmente, NAO 1 por humano.
--   - Apenas o PRIMEIRO humano que codifica o documento entra na fila de
--     auto-revisao para aquele par (doc, campo). Codificacoes humanas
--     subsequentes do mesmo doc continuam fluindo via /compare, mas nao
--     re-disparam auto-revisao (createAutoReviewIfDiverges faz upsert com
--     ignoreDuplicates).
--   - Alinhado ao racional "LLM e gabarito padrao + 1 humano confronta".
--     Se no futuro o produto precisar de auto-revisao por humano, mudar a
--     chave para (document_id, field_name, human_response_id) E adaptar a
--     view final_answers (escolher qual humano ganha quando ha conflito).
--
-- Esta migration so adiciona COMMENT, nao altera esquema. Idempotente.

COMMENT ON CONSTRAINT field_reviews_unique ON field_reviews IS
  'Uma linha por (doc, campo) globalmente. Apenas o primeiro humano que '
  'codifica o doc entra em auto-revisao para aquele campo; codificacoes '
  'subsequentes nao re-disparam o fluxo.';

COMMENT ON TABLE field_reviews IS
  'Auto-revisao (humano vs LLM) + arbitragem em duas fases. 1 linha por '
  '(documento, campo) divergente do primeiro humano que codificou o doc.';
