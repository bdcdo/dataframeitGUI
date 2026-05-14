-- Renomeia responses.is_current → responses.is_latest (follow-up de #85).
--
-- Apos #85 a semantica ficou estavel: "ultima run LLM ou resposta humana
-- ativa", sem invalidar por schema bump. O nome is_current sugeria algo
-- relativo ao schema que a coluna nao promete mais — is_latest descreve
-- melhor o que ela representa.
--
-- RENAME COLUMN propaga automaticamente para objetos dependentes:
--   - final_answers_view passa a referenciar is_latest
--   - o indice parcial idx_responses_project_is_current tem seu predicado
--     reescrito para WHERE is_latest = true
-- O indice e renomeado abaixo so para manter o nome coerente com a coluna.
--
-- Timestamp 20260514190000: esta migration precisa rodar DEPOIS de
-- 20260514180000_field_reviews_self_verdict_equivalente_ambiguo.sql, que
-- recria final_answers_view referenciando responses.is_current. Se o rename
-- rodasse antes, aquela migration falharia (coluna ja renomeada).
--
-- Deploy: a coluna deixa de existir com o nome antigo, entao esta migration
-- e o deploy de codigo (frontend + backend) precisam sair no mesmo PR.

ALTER TABLE responses RENAME COLUMN is_current TO is_latest;

ALTER INDEX IF EXISTS idx_responses_project_is_current
  RENAME TO idx_responses_project_is_latest;
