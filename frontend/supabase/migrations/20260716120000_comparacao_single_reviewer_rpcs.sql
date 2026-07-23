-- Prepara as RPCs de escrita para o índice único parcial
-- assignments_one_active_comparacao_per_doc, criado na migration seguinte
-- (issue #490: um revisor de comparação por documento).
--
-- ORDEM IMPORTA: esta migration vem ANTES da que cria o índice. As funções
-- precisam tolerar a restrição antes de ela existir; invertido, haveria uma
-- janela com índice ativo e RPCs ingênuas — e todas as três abaixo abortam a
-- transação inteira ao receber um unique_violation não tratado.
--
-- As definições originais (20260629120000_atomic_replace_rpcs.sql e
-- 20260715160000_atomic_member_permission_rpcs.sql) já estão aplicadas no
-- remoto e não são editadas: redefinição por CREATE OR REPLACE, preservando
-- assinatura, SECURITY INVOKER e search_path.

-- ========== #181 / #490: sorteio ==========
-- Muda só o ON CONFLICT. `computeLottery` já garante ausência de duplicatas no
-- caminho feliz; o DO NOTHING existe para a CORRIDA: a leitura de assignments
-- acontece FORA desta transação, e entre ela e o INSERT o gatilho automático
-- (createAutoComparisonIfDiverges, disparado por qualquer saveResponse) pode
-- criar a comparação ativa do documento. Como o INSERT é set-based, sem isto
-- UMA linha em conflito abortaria o sorteio INTEIRO de centenas de documentos.
--
-- Sem target de propósito: `ON CONFLICT (colunas)` é arbiter-específico e
-- inferiria apenas assignments_document_id_user_id_type_key, deixando o índice
-- parcial de fora. Sem target, cobre os dois.
--
-- Efeito no retorno: v_inserted passa a ser a contagem REAL de inserções, que
-- pode ser menor que jsonb_array_length(p_assignments). É o número que o TS
-- reporta ao coordenador (smartRandomize), e é o correto: o que está no banco.
CREATE OR REPLACE FUNCTION public.apply_lottery_assignments(
  p_project_id uuid,
  p_type text,
  p_batch_id uuid,
  p_assignments jsonb,
  p_replace boolean
) RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_inserted integer;
BEGIN
  IF p_replace THEN
    DELETE FROM public.assignments
    WHERE project_id = p_project_id
      AND status = 'pendente'
      AND type = p_type;
  END IF;

  INSERT INTO public.assignments (project_id, document_id, user_id, batch_id, type)
  SELECT p_project_id,
         (e->>'document_id')::uuid,
         (e->>'user_id')::uuid,
         p_batch_id,
         p_type
  FROM jsonb_array_elements(p_assignments) AS e
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

GRANT EXECUTE ON FUNCTION
  public.apply_lottery_assignments(uuid, text, uuid, jsonb, boolean)
  TO authenticated;

-- ========== #284 / #490: upload replace_and_add ==========
-- Muda só o WHERE do UPDATE de assignments: não ressuscitar comparações
-- CONCLUÍDAS. O UPDATE reabre todas as atribuições do documento sem filtrar por
-- tipo; com o índice, um documento com duas linhas de comparação (ex.: uma
-- concluída de rodada anterior + uma ativa, combinação que o índice permite por
-- design) passaria a ter duas ATIVAS no mesmo comando — unique_violation, e o
-- upload inteiro sofre rollback depois de reviews e responses já apagados.
--
-- Sob o invariante "no máximo uma comparação ativa por documento", excluir as
-- concluídas garante que este UPDATE nunca cria uma segunda ativa: ele só mexe
-- na que já estava dentro do predicado do índice.
--
-- Semanticamente também é o certo: as respostas do documento acabaram de ser
-- apagadas: um parecer concluído reaberto sobre zero respostas seria um
-- fantasma que a fila da Comparação nem exibiria.
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

GRANT EXECUTE ON FUNCTION
  public.replace_and_add_documents(uuid, uuid[], boolean, jsonb, jsonb)
  TO authenticated;

-- ========== #490: gatilho automático da comparação ==========
-- Muda só o ON CONFLICT, pelo mesmo motivo do sorteio: com target, o índice
-- parcial ficaria de fora e o conflito viraria exceção. O FOR UPDATE existente
-- trava a membership do revisor (can_compare), não serializa por documento —
-- então dois revisores distintos para o mesmo documento é exatamente o que
-- escapa dele.
--
-- Com o DO NOTHING sem target, GET DIAGNOSTICS devolve 0 e a função retorna
-- false, que assignComparisonReviewer (lib/auto-comparison.ts) já interpreta
-- como "não atribuí" — nenhuma mudança no TS. O guard de idempotência de
-- createAutoComparisonIfDiverges (que lê fora da transação, TOCTOU) passa a ser
-- otimização: o árbitro da corrida é o índice.
--
-- Preferido a EXCEPTION WHEN unique_violation: o bloco de exceção do plpgsql
-- abre uma subtransação a cada chamada.
CREATE OR REPLACE FUNCTION public.assign_comparison_if_eligible(
  p_project_id uuid,
  p_document_id uuid,
  p_user_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_inserted integer := 0;
BEGIN
  PERFORM 1
  FROM public.project_members AS pm
  WHERE pm.project_id = p_project_id
    AND pm.user_id = p_user_id
    AND pm.can_compare = true
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO public.assignments (
    project_id,
    document_id,
    user_id,
    type,
    status
  ) VALUES (
    p_project_id,
    p_document_id,
    p_user_id,
    'comparacao',
    'pendente'
  )
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  RETURN v_inserted = 1;
END;
$$;

REVOKE ALL ON FUNCTION
  public.assign_comparison_if_eligible(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.assign_comparison_if_eligible(uuid, uuid, uuid)
  TO service_role;
