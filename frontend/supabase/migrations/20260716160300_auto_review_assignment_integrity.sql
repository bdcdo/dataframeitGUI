-- Materializa a fila de auto-revisão a partir de identidades derivadas das
-- próprias respostas. O contrato anterior recebia seis identificadores
-- independentes e permitia combinar projeto, documento, pesquisador e respostas
-- sem relação entre si; também podia recriar trabalho para um membro removido
-- enquanto a remoção concorrente terminava.
--
-- A API em lote aceita somente os dois IDs de resposta e os campos divergentes.
-- O banco deriva a tupla canônica, trava a membership atual e usa a mesma ordem
-- de locks do fechamento e da reconciliação:
--
--   project_members → advisory → field_reviews → assignments
--
-- Assim o estado inválido deixa de ser representável no contrato público e os
-- dois produtores (envio inline e regeneração do backlog) usam uma transação só.
BEGIN;

DROP FUNCTION IF EXISTS public.assign_auto_review_if_eligible(
  UUID, UUID, UUID, TEXT[], UUID, UUID
);

CREATE OR REPLACE FUNCTION public.assign_auto_reviews_if_eligible(
  p_candidates JSONB
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_item JSONB;
  v_ordinality BIGINT;
  v_human_response_id UUID;
  v_llm_response_id UUID;
  v_project_id UUID;
  v_document_id UUID;
  v_reviewer_id UUID;
  v_schema_fields JSONB;
  v_candidate RECORD;
  v_created INTEGER;
  v_created_total INTEGER := 0;
BEGIN
  IF p_candidates IS NULL
     OR pg_catalog.jsonb_typeof(p_candidates) <> 'array'
  THEN
    RAISE EXCEPTION 'p_candidates deve ser um array JSON'
      USING ERRCODE = '22023';
  END IF;

  IF pg_catalog.jsonb_array_length(p_candidates) = 0 THEN
    RETURN 0;
  END IF;

  -- Valida o lote inteiro antes da primeira escrita. Qualquer candidato ruim
  -- aborta a transação, em vez de deixar um prefixo do lote materializado.
  FOR v_item, v_ordinality IN
    SELECT item.value, item.ordinality
    FROM pg_catalog.jsonb_array_elements(p_candidates)
      WITH ORDINALITY AS item(value, ordinality)
  LOOP
    IF pg_catalog.jsonb_typeof(v_item) <> 'object'
       OR pg_catalog.jsonb_typeof(v_item -> 'human_response_id') <> 'string'
       OR pg_catalog.jsonb_typeof(v_item -> 'llm_response_id') <> 'string'
       OR pg_catalog.jsonb_typeof(v_item -> 'field_names') <> 'array'
       OR pg_catalog.jsonb_array_length(v_item -> 'field_names') = 0
    THEN
      RAISE EXCEPTION 'candidato % tem formato inválido', v_ordinality
        USING ERRCODE = '22023';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(v_item -> 'field_names') AS field(value)
      WHERE pg_catalog.jsonb_typeof(field.value) <> 'string'
        OR pg_catalog.btrim(field.value #>> '{}') = ''
    ) THEN
      RAISE EXCEPTION 'candidato % contém field_name inválido', v_ordinality
        USING ERRCODE = '22023';
    END IF;

    BEGIN
      v_human_response_id := (v_item ->> 'human_response_id')::UUID;
      v_llm_response_id := (v_item ->> 'llm_response_id')::UUID;
    EXCEPTION
      WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'candidato % contém UUID inválido', v_ordinality
          USING ERRCODE = '22023';
    END;

    SELECT
      human_response.project_id,
      human_response.document_id,
      human_response.respondent_id,
      project.pydantic_fields
    INTO
      v_project_id,
      v_document_id,
      v_reviewer_id,
      v_schema_fields
    FROM public.responses AS human_response
    JOIN public.responses AS llm_response
      ON llm_response.project_id = human_response.project_id
     AND llm_response.document_id = human_response.document_id
    JOIN public.documents AS document
      ON document.id = human_response.document_id
     AND document.project_id = human_response.project_id
    JOIN public.projects AS project
      ON project.id = human_response.project_id
    WHERE human_response.id = v_human_response_id
      AND human_response.respondent_type = 'humano'
      AND human_response.respondent_id IS NOT NULL
      AND human_response.is_latest = true
      AND human_response.is_partial = false
      AND llm_response.id = v_llm_response_id
      AND llm_response.respondent_type = 'llm'
      AND llm_response.respondent_id IS NULL
      AND llm_response.is_latest = true
      -- Documento fora de escopo não gera fila. O mesmo predicado vale na
      -- revalidação, na reconciliação e na pós-condição: filtrar só aqui faria
      -- o deploy abortar ao cobrar uma pendência que a reconciliação ignora.
      AND document.excluded_at IS NULL
      AND document.exclusion_pending_at IS NULL;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'candidato % não referencia respostas humana/LLM coerentes com o documento',
        v_ordinality
        USING ERRCODE = '23514';
    END IF;

    IF pg_catalog.jsonb_typeof(v_schema_fields) <> 'array'
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.jsonb_array_elements_text(
           v_item -> 'field_names'
         ) AS requested(field_name)
         WHERE NOT EXISTS (
           SELECT 1
           FROM pg_catalog.jsonb_array_elements(v_schema_fields) AS schema_field(value)
           WHERE schema_field.value ->> 'name' = requested.field_name
         )
       )
    THEN
      RAISE EXCEPTION 'candidato % referencia campo fora do schema do projeto',
        v_ordinality
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  -- Trava todas as memberships em ordem estável antes de qualquer advisory.
  -- Remoção e unificação concorrentes ou terminam antes desta leitura (e o
  -- lote é recusado), ou esperam a materialização terminar.
  FOR v_candidate IN
    SELECT DISTINCT
      human_response.project_id,
      human_response.respondent_id AS reviewer_id
    FROM pg_catalog.jsonb_array_elements(p_candidates) AS item(value)
    JOIN public.responses AS human_response
      ON human_response.id = (item.value ->> 'human_response_id')::UUID
    ORDER BY human_response.project_id, human_response.respondent_id
  LOOP
    PERFORM 1
    FROM public.project_members AS member
    WHERE member.project_id = v_candidate.project_id
      AND member.user_id = v_candidate.reviewer_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'a resposta humana não pertence a um membro atual do projeto'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  -- Candidatos repetidos para o mesmo par de respostas são agregados; campos
  -- repetidos também viram uma única tentativa. A ordem é canônica por
  -- projeto→membro→documento→respostas para lotes concorrentes adquirirem locks
  -- na mesma sequência.
  FOR v_candidate IN
    SELECT
      human_response.project_id,
      human_response.document_id,
      human_response.respondent_id AS reviewer_id,
      human_response.id AS human_response_id,
      llm_response.id AS llm_response_id,
      pg_catalog.array_agg(DISTINCT requested.field_name ORDER BY requested.field_name)
        AS field_names
    FROM pg_catalog.jsonb_array_elements(p_candidates) AS item(value)
    JOIN public.responses AS human_response
      ON human_response.id = (item.value ->> 'human_response_id')::UUID
    JOIN public.responses AS llm_response
      ON llm_response.id = (item.value ->> 'llm_response_id')::UUID
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements_text(
      item.value -> 'field_names'
    ) AS requested(field_name)
    GROUP BY
      human_response.project_id,
      human_response.document_id,
      human_response.respondent_id,
      human_response.id,
      llm_response.id
    ORDER BY
      human_response.project_id,
      human_response.respondent_id,
      human_response.document_id,
      human_response.id,
      llm_response.id
  LOOP
    -- Revalida e protege a tupla depois do lock da membership. Isso fecha a
    -- janela entre a validação inicial e um update concorrente das respostas.
    --
    -- FOR UPDATE, não FOR KEY SHARE: quem supera uma resposta faz
    -- `UPDATE responses SET is_latest = false`, que não toca coluna de chave e
    -- por isso adquire FOR NO KEY UPDATE — modo que NÃO conflita com
    -- FOR KEY SHARE. Com o lock fraco, o UPDATE concorrente não esperava e a
    -- fila era materializada contra uma resposta já superada, que é exatamente
    -- a janela que este bloco existe para fechar.
    PERFORM 1
    FROM public.responses AS human_response
    JOIN public.responses AS llm_response
      ON llm_response.project_id = human_response.project_id
     AND llm_response.document_id = human_response.document_id
    JOIN public.documents AS document
      ON document.id = human_response.document_id
     AND document.project_id = human_response.project_id
    WHERE human_response.id = v_candidate.human_response_id
      AND human_response.project_id = v_candidate.project_id
      AND human_response.document_id = v_candidate.document_id
      AND human_response.respondent_id = v_candidate.reviewer_id
      AND human_response.respondent_type = 'humano'
      AND human_response.is_latest = true
      AND human_response.is_partial = false
      AND llm_response.id = v_candidate.llm_response_id
      AND llm_response.respondent_type = 'llm'
      AND llm_response.respondent_id IS NULL
      AND llm_response.is_latest = true
      AND document.excluded_at IS NULL
      AND document.exclusion_pending_at IS NULL
    -- `document` permanece em KEY SHARE: a exclusão é soft (UPDATE de
    -- excluded_at), então travá-lo para escrita bloquearia o coordenador sem
    -- necessidade — as duas respostas é que precisam do lock forte.
    FOR UPDATE OF human_response, llm_response
    FOR KEY SHARE OF document;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'a tupla de auto-revisão mudou durante a atribuição'
        USING ERRCODE = '40001';
    END IF;

    PERFORM public.lock_auto_review_assignment(
      v_candidate.project_id,
      v_candidate.document_id,
      v_candidate.reviewer_id
    );

    INSERT INTO public.field_reviews (
      project_id,
      document_id,
      field_name,
      human_response_id,
      llm_response_id,
      self_reviewer_id
    )
    SELECT
      v_candidate.project_id,
      v_candidate.document_id,
      field_name,
      v_candidate.human_response_id,
      v_candidate.llm_response_id,
      v_candidate.reviewer_id
    FROM pg_catalog.unnest(v_candidate.field_names) AS field_name
    ON CONFLICT (document_id, field_name) DO NOTHING;

    GET DIAGNOSTICS v_created = ROW_COUNT;
    v_created_total := v_created_total + v_created;

    -- O conflict path acima pode encontrar uma row preexistente; o FOR UPDATE
    -- explícito mantém a ordem field_reviews→assignments também nesse caso.
    PERFORM 1
    FROM public.field_reviews AS review
    WHERE review.project_id = v_candidate.project_id
      AND review.document_id = v_candidate.document_id
      AND review.self_reviewer_id = v_candidate.reviewer_id
    ORDER BY review.id
    FOR UPDATE;

    -- Não cria assignment vazio: conflito com field_review de outro humano ou
    -- retry de campos já resolvidos só produz fila se houver trabalho pendente
    -- pertencente ao membro derivado da resposta humana.
    INSERT INTO public.assignments (
      project_id,
      document_id,
      user_id,
      type,
      status
    )
    SELECT
      v_candidate.project_id,
      v_candidate.document_id,
      v_candidate.reviewer_id,
      'auto_revisao',
      'pendente'
    WHERE EXISTS (
      SELECT 1
      FROM public.field_reviews AS review
      WHERE review.project_id = v_candidate.project_id
        AND review.document_id = v_candidate.document_id
        AND review.self_reviewer_id = v_candidate.reviewer_id
        AND review.self_verdict IS NULL
    )
    ON CONFLICT (document_id, user_id, type) DO UPDATE
    SET status = 'pendente',
        completed_at = NULL
    WHERE assignments.status = 'concluido';
  END LOOP;

  RETURN v_created_total;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_auto_reviews_if_eligible(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_auto_reviews_if_eligible(JSONB)
  TO service_role;

DROP FUNCTION IF EXISTS public.reopen_auto_review_assignments_with_pending(UUID);

CREATE OR REPLACE FUNCTION public.reconcile_auto_review_assignments_with_pending(
  p_project_id UUID
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_pair RECORD;
  v_changed INTEGER;
  v_changed_total INTEGER := 0;
BEGIN
  IF p_project_id IS NULL THEN
    RAISE EXCEPTION 'p_project_id é obrigatório'
      USING ERRCODE = '22023';
  END IF;

  -- Só membros atuais podem ter fila recriada. Pares são processados em ordem
  -- estável e cada um repete a disciplina membership→advisory→reviews→assignment.
  FOR v_pair IN
    SELECT DISTINCT
      review.self_reviewer_id AS reviewer_id,
      review.document_id
    FROM public.field_reviews AS review
    JOIN public.project_members AS member
      ON member.project_id = review.project_id
     AND member.user_id = review.self_reviewer_id
    JOIN public.documents AS document
      ON document.id = review.document_id
     AND document.project_id = review.project_id
    WHERE review.project_id = p_project_id
      AND review.self_verdict IS NULL
      -- Mesmo escopo da atribuição: documento fora de escopo não reabre fila.
      AND document.excluded_at IS NULL
      AND document.exclusion_pending_at IS NULL
    ORDER BY review.self_reviewer_id, review.document_id
  LOOP
    PERFORM 1
    FROM public.project_members AS member
    WHERE member.project_id = p_project_id
      AND member.user_id = v_pair.reviewer_id
    FOR UPDATE;

    -- A membership pode ter desaparecido entre a enumeração e o lock. Nesse
    -- caso o par deixa de ser elegível e não recebe assignment órfão.
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    PERFORM public.lock_auto_review_assignment(
      p_project_id,
      v_pair.document_id,
      v_pair.reviewer_id
    );

    PERFORM 1
    FROM public.field_reviews AS review
    WHERE review.project_id = p_project_id
      AND review.document_id = v_pair.document_id
      AND review.self_reviewer_id = v_pair.reviewer_id
    ORDER BY review.id
    FOR UPDATE;

    IF NOT EXISTS (
      SELECT 1
      FROM public.field_reviews AS review
      WHERE review.project_id = p_project_id
        AND review.document_id = v_pair.document_id
        AND review.self_reviewer_id = v_pair.reviewer_id
        AND review.self_verdict IS NULL
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO public.assignments (
      project_id,
      document_id,
      user_id,
      type,
      status
    ) VALUES (
      p_project_id,
      v_pair.document_id,
      v_pair.reviewer_id,
      'auto_revisao',
      'pendente'
    )
    ON CONFLICT (document_id, user_id, type) DO UPDATE
    SET status = 'pendente',
        completed_at = NULL
    WHERE assignments.status = 'concluido';

    GET DIAGNOSTICS v_changed = ROW_COUNT;
    v_changed_total := v_changed_total + v_changed;
  END LOOP;

  RETURN v_changed_total;
END;
$$;

REVOKE ALL ON FUNCTION
  public.reconcile_auto_review_assignments_with_pending(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.reconcile_auto_review_assignments_with_pending(UUID)
  TO service_role;

-- Repara filas históricas dentro da própria migration. A chamada por projeto
-- é determinística e a pós-condição torna drift residual um erro de deploy.
DO $$
DECLARE
  v_project_id UUID;
BEGIN
  FOR v_project_id IN
    SELECT DISTINCT review.project_id
    FROM public.field_reviews AS review
    JOIN public.project_members AS member
      ON member.project_id = review.project_id
     AND member.user_id = review.self_reviewer_id
    JOIN public.documents AS document
      ON document.id = review.document_id
     AND document.project_id = review.project_id
    WHERE review.self_verdict IS NULL
      AND document.excluded_at IS NULL
      AND document.exclusion_pending_at IS NULL
    ORDER BY review.project_id
  LOOP
    PERFORM public.reconcile_auto_review_assignments_with_pending(v_project_id);
  END LOOP;

  -- A pós-condição usa o mesmo escopo da reconciliação. Cobrar aqui um
  -- documento que a reconciliação ignora por estar fora de escopo abortaria o
  -- deploy por um drift que, por contrato, não deve ser reparado.
  IF EXISTS (
    SELECT 1
    FROM public.field_reviews AS review
    JOIN public.project_members AS member
      ON member.project_id = review.project_id
     AND member.user_id = review.self_reviewer_id
    JOIN public.documents AS document
      ON document.id = review.document_id
     AND document.project_id = review.project_id
    WHERE review.self_verdict IS NULL
      AND document.excluded_at IS NULL
      AND document.exclusion_pending_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.assignments AS assignment
        WHERE assignment.project_id = review.project_id
          AND assignment.document_id = review.document_id
          AND assignment.user_id = review.self_reviewer_id
          AND assignment.type = 'auto_revisao'
          AND assignment.status IS DISTINCT FROM 'concluido'
      )
  ) THEN
    RAISE EXCEPTION
      'há field_review pendente de membro atual sem assignment ativo'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

COMMIT;
