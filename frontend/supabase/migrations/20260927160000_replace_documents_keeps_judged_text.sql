-- Substituir duplicatas mantendo as respostas não pode trocar o texto julgado.
--
-- Um julgamento (resposta, veredito da Comparação, par "=", auto-revisão,
-- decisão do LLM Insights) vale enquanto o objeto julgado não muda. A pergunta
-- já tem mecanismo para isso (`reviews.field_hash` e 20260927130000); o texto
-- do documento não tinha: `replace_and_add_documents` com
-- `p_delete_responses = false` fazia `UPDATE documents SET text = ...` e
-- mantinha todos esses julgamentos, feitos sobre o texto antigo, sem nenhum
-- sinal no Gabarito, no export ou na métrica.
--
-- Em vez de carimbar a versão do texto em cada julgamento e ensinar cada
-- leitor a descartá-lo, a RPC passa a recusar a troca: se algum documento do
-- lote de atualização receberia texto diferente e ainda tem respostas, a
-- chamada inteira aborta (inclusive os DELETE de respostas e os INSERT de
-- documentos novos do mesmo lote) e nada muda. O caminho para trocar o texto é
-- apagar as respostas desses documentos, que já existe na tela de duplicatas.
-- Título, metadados e external_id continuam atualizáveis quando o texto é o
-- mesmo, e documento sem resposta nenhuma continua podendo trocar de texto:
-- não há julgamento a proteger.
--
-- A guarda lê o estado, e não o pedido: roda depois do bloco de DELETE e
-- pergunta se o documento ainda tem resposta naquele ponto. Uma guarda que
-- olhasse `p_delete_responses` deixaria passar a chamada com `true` em que o
-- documento atualizado não está em `p_existing_doc_ids`: nada seria apagado e
-- o texto trocaria com a resposta no lugar. Lendo o estado, esse caso é
-- recusado, e `p_delete_responses` NULL deixa de precisar de tratamento
-- próprio.
--
-- A comparação é pelo próprio texto, e não por `text_hash`: `d.text_hash` pode
-- ser NULL (a coluna nasceu em 20260316 sem NOT NULL; o backfill daquela
-- migration cobriu as linhas de então, mas nada impede uma escrita posterior
-- sem hash) e `u.text_hash` chega do chamador sem conferência, então um hash
-- que não corresponda ao texto enviado abriria a guarda. `IS DISTINCT FROM`
-- sobre o texto não depende de nenhum dos dois. Por isso a diferença só de formatação (quebra de linha, espaço no fim)
-- conta como troca, e a mensagem avisa disso.
--
-- "Com respostas" usa o mesmo critério da tela de duplicatas (`checkDuplicates`
-- em actions/documents.ts conta documentos com linha em `responses`, lida pela
-- mesma sessão): é esse número que decide se a tela oferece a opção de apagar
-- as respostas. Contar outra coisa aqui poderia recusar uma troca sem que a
-- tela mostrasse a saída. A mesma `checkDuplicates` conta, só lendo, as
-- duplicatas com resposta cujo `text_hash` gravado difere do hash do texto
-- novo, e o upload recusa antes de gravar o primeiro chunk: sem isso a recusa
-- podia cair num chunk posterior, com os anteriores já gravados. Documento com
-- `text_hash` NULL escapa dessa conta; esta guarda continua sendo a autoridade.
--
-- A mensagem nomeia as opções exatamente como aparecem na tela
-- (components/documents/DuplicateAnalysis.tsx) e é a mesma que a pré-checagem
-- devolve (TEXT_CHANGE_WITH_RESPONSES_MESSAGE em lib/upload-chunking.ts, que um
-- teste confere contra este arquivo). Ela diz que apagar as respostas vale para
-- todas as duplicatas do envio, inclusive as de texto igual, porque a tela
-- manda como `p_existing_doc_ids` a lista inteira de duplicatas.
--
-- ERRCODE 55000 (object_not_in_prerequisite_state): o pedido é válido, mas os
-- documentos não estão no estado que ele exige (sem respostas). A mensagem vai
-- direto ao toast do upload e não leva dígito nenhum: o upload trata como
-- "payload grande demais" qualquer erro que contenha "413"
-- (`isPayloadTooLarge` em lib/upload-chunking.ts), e uma contagem com esses
-- dígitos trocaria a mensagem por outra, errada.
--
-- Redefinição por CREATE OR REPLACE a partir do corpo vigente
-- (20260716120000_comparacao_single_reviewer_rpcs.sql), preservando
-- assinatura, SECURITY INVOKER e search_path. A única mudança é a guarda entre
-- o DELETE e o UPDATE. CREATE OR REPLACE mantém os privilégios existentes,
-- então os REVOKE/GRANT de 20260724120000_rls_audit_hardening.sql continuam
-- valendo.
CREATE OR REPLACE FUNCTION public.replace_and_add_documents(
  p_project_id uuid,
  p_existing_doc_ids uuid[],
  p_delete_responses boolean,
  p_duplicate_updates jsonb,
  p_new_documents jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_inserted integer := 0;
BEGIN
  IF p_delete_responses
     AND p_existing_doc_ids IS NOT NULL
     AND array_length(p_existing_doc_ids, 1) > 0 THEN
    -- reviews antes (FK chosen_response_id -> responses sem CASCADE)
    DELETE FROM public.reviews
    WHERE project_id = p_project_id
      AND document_id = ANY(p_existing_doc_ids);

    DELETE FROM public.responses
    WHERE project_id = p_project_id
      AND document_id = ANY(p_existing_doc_ids);

    UPDATE public.assignments
    SET status = 'pendente'
    WHERE project_id = p_project_id
      AND document_id = ANY(p_existing_doc_ids)
      AND NOT (type = 'comparacao' AND status = 'concluido');
  END IF;

  IF p_duplicate_updates IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM jsonb_to_recordset(p_duplicate_updates) AS u(id uuid, "text" text)
       JOIN public.documents d
         ON d.id = u.id
        AND d.project_id = p_project_id
       WHERE d."text" IS DISTINCT FROM u."text"
         AND EXISTS (
           SELECT 1 FROM public.responses r
           WHERE r.project_id = p_project_id
             AND r.document_id = d.id
         )
     ) THEN
    RAISE EXCEPTION
      'Há documentos já respondidos cujo texto no arquivo difere do texto atual, mesmo que só na formatação (quebra de linha, espaço no fim). As respostas valem para o texto atual. Para manter esses documentos como estão, use "Importar apenas novos" (ou "Voltar ao mapeamento", se não houver novos). Para trocar o texto, use "Substituir duplicatas e importar novos" com "Apagar respostas e exigir re-codificação", que apaga as respostas de todas as duplicatas do envio, inclusive as de texto igual.'
      USING ERRCODE = '55000';
  END IF;

  IF p_duplicate_updates IS NOT NULL
     AND jsonb_array_length(p_duplicate_updates) > 0 THEN
    UPDATE public.documents d
    SET text = u."text",
        title = u.title,
        external_id = u.external_id,
        text_hash = u.text_hash,
        metadata = u.metadata
    FROM jsonb_to_recordset(p_duplicate_updates)
      AS u(id uuid, "text" text, title text, external_id text,
           text_hash text, metadata jsonb)
    WHERE d.id = u.id
      AND d.project_id = p_project_id;  -- defense-in-depth: escopa ao projeto,
                                        -- coerente com os DELETE/INSERT acima
  END IF;

  IF p_new_documents IS NOT NULL
     AND jsonb_array_length(p_new_documents) > 0 THEN
    INSERT INTO public.documents
      (project_id, external_id, title, text, text_hash, metadata)
    SELECT p_project_id, n.external_id, n.title, n."text", n.text_hash, n.metadata
    FROM jsonb_to_recordset(p_new_documents)
      AS n(external_id text, title text, "text" text,
           text_hash text, metadata jsonb);
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
  END IF;

  RETURN v_inserted;
END;
$$;
