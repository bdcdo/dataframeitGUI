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
-- documento x usuario que esta view nao resolve. Ver issue de acompanhamento
-- (#409).
--
-- security_invoker = true (revisao da PR #408): sem essa opcao, explicita
-- desde o PG15, a view checa RLS com os privilegios do DONO da view (o role
-- de migrations do Supabase, tipicamente com BYPASSRLS) em vez do usuario que
-- consulta -- ou seja, SEM esta clausula a RLS das tabelas base seria
-- efetivamente ignorada para qualquer authenticated, e o .eq("project_id",
-- ...) do app seria so um filtro, nao uma barreira de autorizacao.

CREATE OR REPLACE VIEW lottery_doc_stats WITH (security_invoker = true) AS
SELECT
  d.id,
  d.project_id,
  d.external_id,
  d.title,
  COALESCE(hr.human_coding_count, 0)::integer AS human_coding_count,
  COALESCE(hr.has_llm_response, false) AS has_llm_response,
  COALESCE(aa.active_codificacao, 0)::integer AS active_codificacao,
  COALESCE(aa.active_comparacao, 0)::integer AS active_comparacao,
  COALESCE(aa.has_any_assignment_ever, false) AS has_any_assignment_ever,
  COALESCE(aa.batch_ids, ARRAY[]::uuid[]) AS batch_ids
FROM documents d
LEFT JOIN LATERAL (
  SELECT
    COUNT(DISTINCT respondent_id) FILTER (WHERE respondent_type = 'humano') AS human_coding_count,
    bool_or(respondent_type = 'llm') AS has_llm_response
  FROM responses r
  WHERE r.document_id = d.id AND r.project_id = d.project_id AND r.is_latest = true
) hr ON true
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

-- Sem este indice, o LATERAL join de assignments acima faria seq scan por
-- documento: assignments hoje so tem indices em (project_id, user_id),
-- (project_id, type) e (project_id, status), nenhum cobrindo document_id.
CREATE INDEX IF NOT EXISTS idx_assignments_project_document ON assignments(project_id, document_id);

-- Idem para o LATERAL de responses acima: idx_responses_project_document
-- cobre (project_id, document_id) mas exige heap lookup extra para filtrar
-- is_latest/respondent_type; idx_responses_project_is_latest e parcial mas
-- so tem project_id na chave (nao seletivo por documento). Este cobre os
-- tres predicados usados pelo LATERAL "hr" numa unica passada.
CREATE INDEX IF NOT EXISTS idx_responses_project_document_type_latest
  ON responses(project_id, document_id, respondent_type)
  WHERE is_latest = true;
