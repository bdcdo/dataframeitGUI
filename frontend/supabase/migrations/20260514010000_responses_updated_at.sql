-- responses.updated_at: marca a ultima vez que a resposta foi gravada
-- (insert ou update). saveResponse() faz upsert por (project, document,
-- respondent), entao created_at so reflete a primeira submissao. updated_at
-- permite ordenar a navegacao da aba Codificar por "codificados recentemente"
-- (issue #108) — a data e a da codificacao do proprio pesquisador, nao a do
-- upload do documento.
--
-- Sem trigger: o codebase nao usa triggers de updated_at; saveResponse()
-- (unico caminho de escrita de responses humanas) seta updated_at explicito,
-- e o DEFAULT now() cobre os inserts.

ALTER TABLE responses ADD COLUMN updated_at TIMESTAMPTZ;

-- Backfill: melhor sinal disponivel para linhas antigas e a propria criacao.
UPDATE responses SET updated_at = COALESCE(created_at, now());

ALTER TABLE responses ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE responses ALTER COLUMN updated_at SET NOT NULL;
