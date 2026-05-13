-- View que resolve o "gabarito" de cada (documento, campo) a partir das
-- respostas LLM/humana + field_reviews. Consumida por exports e dashboards.
--
-- Provenance:
--   consenso              → sem field_review (humano = LLM ou nao codificou)
--   aguarda_auto_revisao  → field_review existe mas self_verdict ainda NULL
--   auto_corrigido        → humano admitiu erro, gabarito = LLM
--   aguarda_arbitragem    → humano contestou LLM, arbitragem nao concluida
--   arbitrado             → final_verdict definido pelo arbitro
--
-- SECURITY INVOKER (default): respeita RLS de responses/field_reviews/projects.

CREATE OR REPLACE VIEW final_answers AS
SELECT
  r_llm.project_id,
  r_llm.document_id,
  fld.field_name,
  CASE
    WHEN fr.id IS NULL THEN r_llm.answers -> fld.field_name
    WHEN fr.self_verdict IS NULL THEN NULL
    WHEN fr.self_verdict = 'admite_erro' THEN r_llm.answers -> fld.field_name
    WHEN fr.final_verdict IS NULL THEN NULL
    WHEN fr.final_verdict = 'humano' THEN r_hum.answers -> fld.field_name
    WHEN fr.final_verdict = 'llm' THEN r_llm.answers -> fld.field_name
    ELSE NULL
  END AS answer,
  CASE
    WHEN fr.id IS NULL THEN 'consenso'
    WHEN fr.self_verdict IS NULL THEN 'aguarda_auto_revisao'
    WHEN fr.self_verdict = 'admite_erro' THEN 'auto_corrigido'
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

GRANT SELECT ON final_answers TO anon, authenticated, service_role;
