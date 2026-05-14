-- Justificativa do pesquisador ao contestar o LLM na auto-revisao.
--
-- Quando o humano original define self_verdict='contesta_llm', ele agora
-- registra por que acha que sua resposta esta correta. Essa justificativa e
-- exibida ao arbitro na fase de revelacao da arbitragem (segunda etapa), ao
-- lado da resposta humana — espelhando a justificativa do LLM.
--
-- Nullable: field_reviews anteriores a esta migration ficam com NULL; a UI
-- trata ausencia como "sem justificativa".

ALTER TABLE field_reviews ADD COLUMN self_justification TEXT;
