-- Amplia field_reviews.self_verdict com dois vereditos resolutivos novos:
--   - equivalente: humano e LLM responderam o mesmo de formas diferentes; o par
--     de respostas vai para response_equivalences e o campo fica resolvido sem
--     arbitragem (a divergencia nao reaparece porque a auto-revisao passa a
--     consultar response_equivalences).
--   - ambiguo: o campo e genuinamente ambiguo; gera um project_comments para
--     discussao e o campo fica resolvido sem arbitragem.
--
-- A constraint inline original de 20260513000001_field_reviews.sql foi
-- auto-nomeada field_reviews_self_verdict_check pelo Postgres.

ALTER TABLE field_reviews DROP CONSTRAINT IF EXISTS field_reviews_self_verdict_check;
ALTER TABLE field_reviews ADD CONSTRAINT field_reviews_self_verdict_check
  CHECK (self_verdict IN ('admite_erro', 'contesta_llm', 'equivalente', 'ambiguo'));

-- Recria final_answers para refletir os vereditos novos. Sem isto, campos com
-- self_verdict IN ('equivalente','ambiguo') caiam no ramo `final_verdict IS NULL`
-- e apareciam como provenance='aguarda_arbitragem' com answer=NULL — ou seja,
-- "resolvidos" pela auto-revisao mas presos como pendentes de arbitragem.
--
--   equivalente → humano ≈ LLM; gabarito = resposta humana (a original),
--                 provenance='equivalente'. Entra no dataset final.
--   ambiguo     → sem gabarito definido; answer=NULL, provenance='ambiguo'
--                 (estado terminal "precisa discussao", != aguarda_arbitragem).
--
-- Provenance map atualizado:
--   consenso              → sem field_review (humano = LLM ou nao codificou)
--   aguarda_auto_revisao  → field_review existe mas self_verdict ainda NULL
--   auto_corrigido        → humano admitiu erro, gabarito = LLM
--   equivalente           → humano e LLM equivalentes, gabarito = humano
--   ambiguo               → campo ambiguo, sem gabarito, aguarda discussao
--   aguarda_arbitragem    → humano contestou LLM, arbitragem nao concluida
--   arbitrado             → final_verdict definido pelo arbitro
--
-- Para gabarito FINAL (exports CSV, dashboards de gabarito), filtrar:
--   WHERE provenance IN ('consenso', 'auto_corrigido', 'equivalente', 'arbitrado')
-- Linhas 'aguarda_*' e 'ambiguo' tem answer = NULL e nao devem entrar no
-- dataset final.

CREATE OR REPLACE VIEW final_answers AS
SELECT
  r_llm.project_id,
  r_llm.document_id,
  fld.field_name,
  CASE
    WHEN fr.id IS NULL THEN r_llm.answers -> fld.field_name
    WHEN fr.self_verdict IS NULL THEN NULL
    WHEN fr.self_verdict = 'admite_erro' THEN r_llm.answers -> fld.field_name
    WHEN fr.self_verdict = 'equivalente' THEN r_hum.answers -> fld.field_name
    WHEN fr.self_verdict = 'ambiguo' THEN NULL
    WHEN fr.final_verdict IS NULL THEN NULL
    WHEN fr.final_verdict = 'humano' THEN r_hum.answers -> fld.field_name
    WHEN fr.final_verdict = 'llm' THEN r_llm.answers -> fld.field_name
    ELSE NULL
  END AS answer,
  CASE
    WHEN fr.id IS NULL THEN 'consenso'
    WHEN fr.self_verdict IS NULL THEN 'aguarda_auto_revisao'
    WHEN fr.self_verdict = 'admite_erro' THEN 'auto_corrigido'
    WHEN fr.self_verdict = 'equivalente' THEN 'equivalente'
    WHEN fr.self_verdict = 'ambiguo' THEN 'ambiguo'
    WHEN fr.final_verdict IS NULL THEN 'aguarda_arbitragem'
    ELSE 'arbitrado'
  END AS provenance,
  fr.id AS field_review_id,
  fr.changed_after_justification
FROM responses r_llm
JOIN projects p ON p.id = r_llm.project_id
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p.pydantic_fields, '[]'::jsonb)) AS fld_raw
CROSS JOIN LATERAL (SELECT fld_raw->>'name' AS field_name) AS fld
LEFT JOIN field_reviews fr
  ON fr.document_id = r_llm.document_id
  AND fr.field_name = fld.field_name
LEFT JOIN responses r_hum
  ON r_hum.id = fr.human_response_id
WHERE r_llm.respondent_type = 'llm'
  AND r_llm.is_current = true;

-- App e autenticado via Clerk; nao expor a anon (defesa em profundidade).
GRANT SELECT ON final_answers TO authenticated, service_role;
