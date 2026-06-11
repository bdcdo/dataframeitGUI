-- Sorteio v2 (spec 001): modo de interação com pendentes, modo de equilíbrio
-- e snapshot da configuração de elegibilidade/participantes do sorteio.
-- Defaults descrevem os lotes históricos: todos substitutivos ('replace') e
-- com nivelamento por carga acumulada ('history'). A UI envia 'append'/'round'
-- como defaults para sorteios novos.
ALTER TABLE assignment_batches
  ADD COLUMN mode      TEXT NOT NULL DEFAULT 'replace' CHECK (mode IN ('append', 'replace')),
  ADD COLUMN balancing TEXT NOT NULL DEFAULT 'history' CHECK (balancing IN ('round', 'history')),
  ADD COLUMN filters   JSONB;
