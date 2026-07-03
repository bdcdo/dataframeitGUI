-- View que agrega, por documento ativo, as estatisticas de elegibilidade do
-- dialog de sorteio (issue #182): humanCodingCount, hasLlmResponse,
-- activeAssignments por tipo, hasAnyAssignmentEver e batchIds. Substitui, no
-- path de EXIBICAO (getLotteryDocStats, chamado a cada abertura do dialog),
-- o fetch bruto de responses+assignments do projeto inteiro por uma unica
-- query bounded pelo numero de documentos ativos.
--
-- O path de EXECUCAO do sorteio (computeLottery/previewLottery/smartRandomize)
-- continua buscando assignments brutos para o calculo do conjunto preservado
-- e da matriz de coocorrencia entre participantes -- aritmetica por par
-- documento x usuario que esta view nao resolve. Ver issue de acompanhamento.
--
-- SECURITY INVOKER (default): respeita a RLS de documents/responses/assignments
-- (policies "Members view documents/responses/assignments" -- projects
-- acessiveis ao clerk_uid() do chamador). O app ainda filtra
-- .eq("project_id", projectId) explicitamente, como defesa em profundidade.

CREATE OR REPLACE VIEW lottery_doc_stats AS
SELECT
  d.id,
  d.project_id,
  d.external_id,
  d.title,
  COALESCE(hr.human_coding_count, 0)::integer AS human_coding_count,
  COALESCE(lr.has_llm_response, false) AS has_llm_response,
  COALESCE(aa.active_codificacao, 0)::integer AS active_codificacao,
  COALESCE(aa.active_comparacao, 0)::integer AS active_comparacao,
  COALESCE(aa.has_any_assignment_ever, false) AS has_any_assignment_ever,
  COALESCE(aa.batch_ids, ARRAY[]::uuid[]) AS batch_ids
FROM documents d
LEFT JOIN LATERAL (
  SELECT COUNT(DISTINCT respondent_id) AS human_coding_count
  FROM responses r
  WHERE r.document_id = d.id AND r.project_id = d.project_id
    AND r.is_latest = true AND r.respondent_type = 'humano'
) hr ON true
LEFT JOIN LATERAL (
  SELECT EXISTS (
    SELECT 1 FROM responses r
    WHERE r.document_id = d.id AND r.project_id = d.project_id
      AND r.is_latest = true AND r.respondent_type = 'llm'
  ) AS has_llm_response
) lr ON true
LEFT JOIN LATERAL (
  SELECT
    COUNT(*) FILTER (WHERE a.type = 'codificacao' AND a.status IN ('pendente', 'em_andamento')) AS active_codificacao,
    COUNT(*) FILTER (WHERE a.type = 'comparacao' AND a.status IN ('pendente', 'em_andamento')) AS active_comparacao,
    COUNT(*) > 0 AS has_any_assignment_ever,
    array_agg(DISTINCT a.batch_id) FILTER (WHERE a.batch_id IS NOT NULL) AS batch_ids
  FROM assignments a
  WHERE a.document_id = d.id AND a.project_id = d.project_id
) aa ON true
WHERE d.excluded_at IS NULL AND d.exclusion_pending_at IS NULL;

-- App e autenticado via Clerk; nao expor a anon (mesma defesa em profundidade
-- aplicada em final_answers).
GRANT SELECT ON lottery_doc_stats TO authenticated, service_role;

-- Sem este indice, os LATERAL joins de assignments acima fariam seq scan por
-- documento: assignments hoje so tem indices em (project_id, user_id),
-- (project_id, type) e (project_id, status), nenhum cobrindo document_id.
CREATE INDEX IF NOT EXISTS idx_assignments_project_document ON assignments(project_id, document_id);
