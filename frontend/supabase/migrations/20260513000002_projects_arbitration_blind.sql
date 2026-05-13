-- Flag por projeto: na fase 2 da arbitragem (revelacao apos blind),
-- TRUE = manter rotulos "Resposta A / Resposta B" + so revela justificativa LLM
--        (nao revela qual e humano, embora a justificativa possa entregar)
-- FALSE = mostrar rotulos "Humano (Maria)" / "LLM (gemini-3-flash)" explicitos

ALTER TABLE projects ADD COLUMN arbitration_blind BOOLEAN NOT NULL DEFAULT true;
