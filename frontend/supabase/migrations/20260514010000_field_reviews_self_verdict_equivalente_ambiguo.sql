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

ALTER TABLE field_reviews DROP CONSTRAINT field_reviews_self_verdict_check;
ALTER TABLE field_reviews ADD CONSTRAINT field_reviews_self_verdict_check
  CHECK (self_verdict IN ('admite_erro', 'contesta_llm', 'equivalente', 'ambiguo'));
