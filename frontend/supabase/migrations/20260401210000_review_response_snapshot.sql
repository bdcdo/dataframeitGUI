-- Snapshot de respostas no momento do veredito
-- Preserva respostas (incl. LLM) mesmo quando schema muda depois
ALTER TABLE reviews ADD COLUMN response_snapshot JSONB;
