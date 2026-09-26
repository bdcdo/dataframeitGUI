-- A decisão do LLM Insights passa a cair só quando a pergunta muda, pelo hash
-- do campo, como o veredito da Comparação, o par "=" e a auto-revisão.
--
-- O contexto da decisão (`llm_error_context`) guarda a definição inteira do
-- campo em `field_definition`, e até aqui a decisão só valia com o contexto
-- recalculado idêntico ao guardado. Qualquer edição do campo a derrubava:
-- `help_text` que só esclarece, `condition`, `required`,
-- `justification_prompt`. A decisão voltava à fila para ser redecidida sem
-- que a pergunta tivesse mudado.
--
-- Regra nova: o contexto vale quando tudo fora de `field_definition` é igual
-- e a pergunta é a mesma, medida pelo `hash` da definição (nome, tipo, opções,
-- descrição e o contador de revisão da pergunta quando presente, a fórmula de
-- `computeFieldHash` em frontend/src/lib/schema-utils.ts). A edição de
-- instrução que muda como responder continua derrubando a decisão, porque
-- quem edita marca a revisão e o contador entra no hash.
--
-- A condição não derruba a decisão por conta própria. Com o hash igual, a
-- resposta do LLM e a humana do contexto continuam as mesmas (qualquer
-- mudança nelas muda `responses_hash` e os valores do contexto); o que a
-- condição nova pode mudar é se a pergunta se aplica ao documento, e isso é
-- conferido pelo gate do export, não pela decisão.
--
-- Sem hash nos dois lados, a comparação cai para a definição inteira, a regra
-- anterior. No banco não há cópia da fórmula do hash para derivá-lo: a
-- comparação daqui é a de `set_error_resolution`, entre o contexto que o
-- cliente pediu e o recalculado na mesma confirmação, e os dois saem do mesmo
-- `pydantic_fields`, então só diferem em hash se o schema foi salvo no meio, e
-- aí recarregar é o certo. A leitura da validade de uma decisão gravada é a
-- cópia TypeScript (`contextIsCurrent`, frontend/src/lib/error-resolution.ts),
-- que deriva o hash da definição gravada pela mesma fórmula quando ele falta.
--
-- `set_error_resolution` é o corpo de 20260927140000_both_correct_common_value.sql
-- sem outra mudança além da comparação. A assinatura não muda, então
-- `OR REPLACE` preserva SECURITY DEFINER, search_path e os grants de
-- 20260918130000. O contexto gravado continua sendo o recalculado, com a
-- definição atual inteira.

BEGIN;

-- ── Contexto corrente pela pergunta ──────────────────────────────────────────
-- Pura sobre o JSON. Contexto que não é objeto (NULL do `llm_error_context`
-- quando a fonte some) nunca é corrente.
CREATE FUNCTION public.error_resolution_context_current(p_saved JSONB, p_current JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN pg_catalog.jsonb_typeof(p_saved) IS DISTINCT FROM 'object'
      OR pg_catalog.jsonb_typeof(p_current) IS DISTINCT FROM 'object' THEN false
    ELSE (p_saved - 'field_definition') = (p_current - 'field_definition')
      AND CASE
        WHEN pg_catalog.jsonb_typeof(p_saved #> '{field_definition,hash}') = 'string'
          AND pg_catalog.jsonb_typeof(p_current #> '{field_definition,hash}') = 'string'
        THEN (p_saved #> '{field_definition,hash}') = (p_current #> '{field_definition,hash}')
        ELSE (p_saved -> 'field_definition') IS NOT DISTINCT FROM (p_current -> 'field_definition')
      END
  END;
$$;

-- Interna: só `set_error_resolution` (DEFINER) a chama. O cliente lê a
-- validade pela cópia TypeScript.
REVOKE ALL ON FUNCTION public.error_resolution_context_current(JSONB, JSONB)
  FROM PUBLIC, anon, authenticated, service_role;

-- ── set_error_resolution ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_error_resolution(
  p_project_id UUID, p_document_id UUID, p_field_name TEXT,
  p_decision TEXT, p_expected_context JSONB, p_expected_id UUID,
  p_expected_resolved_at TIMESTAMPTZ, p_note TEXT DEFAULT NULL, p_value JSONB DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor UUID := public.clerk_uid();
  v_existing public.error_resolutions%ROWTYPE;
  v_context JSONB;
  v_saved public.error_resolutions%ROWTYPE;
  v_field JSONB;
  v_conditional BOOLEAN;
  v_blank JSONB;
  v_llm_blank BOOLEAN;
  v_common JSONB;
  v_problem TEXT;
  v_requires_source BOOLEAN;
BEGIN
  IF v_actor IS NULL OR NOT COALESCE((
    p_project_id IN (SELECT public.auth_user_coordinator_or_creator_project_ids())
    OR p_project_id IN (SELECT public.auth_user_resolver_project_ids()) OR public.is_master()
  ), false) THEN RAISE EXCEPTION 'Sem permissão para decidir esta divergência' USING ERRCODE = '42501'; END IF;
  IF p_decision IS NOT NULL AND p_decision NOT IN ('llm_correct', 'researchers_correct', 'discussion', 'both_correct', 'all_wrong')
    THEN RAISE EXCEPTION 'Decisão inválida' USING ERRCODE = '22023'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'error-resolution:' || p_project_id || ':' || p_document_id || ':' || p_field_name, 0));
  SELECT * INTO v_existing FROM public.error_resolutions
    WHERE project_id = p_project_id AND document_id = p_document_id AND field_name = p_field_name FOR UPDATE;
  IF v_existing.id IS DISTINCT FROM p_expected_id OR v_existing.resolved_at IS DISTINCT FROM p_expected_resolved_at THEN
    RAISE EXCEPTION 'A decisão mudou. Recarregue antes de confirmar.' USING ERRCODE = '40001';
  END IF;
  IF p_decision IS NULL THEN
    IF v_existing.id IS NULL THEN RAISE EXCEPTION 'Esta divergência já está aberta.' USING ERRCODE = '40001'; END IF;
    DELETE FROM public.error_resolutions WHERE id = v_existing.id;
    RETURN pg_catalog.jsonb_build_object('reopened', true);
  END IF;

  -- "Ambos corretos" com o valor comum. Se ha valor comum e a fila que decide,
  -- porque depende das respostas dos demais pesquisadores, das quais o
  -- contexto guarda so o hash, e dos pares "=", que ele nao guarda; mais
  -- abaixo se confere o que o contexto prova. Sem valor
  -- (NULL ou JSON null), o veredito continua valendo.
  v_common := CASE WHEN p_decision = 'both_correct' THEN NULLIF(p_value, 'null'::JSONB) END;

  -- Decisao que depende do veredito da fonte ("Ambos corretos" sem o valor
  -- comum, "Em discussao") nao nasce sobre veredito que perdeu a validade. A
  -- mensagem propria existe porque o NULL do contexto abaixo mandaria
  -- recarregar uma pagina que nao vai mudar. A lista e a das decisoes com
  -- valor proprio, como em `read_error_resolutions`, para que um tipo novo
  -- nasca exigindo a fonte.
  v_requires_source := p_decision NOT IN ('llm_correct', 'researchers_correct', 'all_wrong')
    AND v_common IS NULL;
  IF v_requires_source AND p_expected_context->'source'->>'kind' = 'comparacao'
    AND EXISTS (SELECT 1 FROM public.reviews WHERE id = (p_expected_context->'source'->>'id')::UUID
                  AND project_id = p_project_id AND document_id = p_document_id AND field_name = p_field_name)
    AND NOT public.review_is_valid((p_expected_context->'source'->>'id')::UUID) THEN
    RAISE EXCEPTION 'O veredito anterior não vale mais: "Ambos corretos" e "Em discussão" dependem dele. Rearbitre a célula na Comparação.'
      USING ERRCODE = '22023';
  END IF;
  v_context := public.llm_error_context(p_project_id, p_document_id, p_field_name,
    (p_expected_context->>'llm_response_id')::UUID, (p_expected_context->>'human_response_id')::UUID,
    p_expected_context->'source'->>'kind', (p_expected_context->'source'->>'id')::UUID,
    v_requires_source);
  IF v_context IS NULL OR NOT public.error_resolution_context_current(p_expected_context, v_context) THEN
    RAISE EXCEPTION 'As respostas mudaram. Recarregue antes de confirmar.' USING ERRCODE = '40001';
  END IF;
  v_field := v_context->'field_definition';
  -- COALESCE: sem a chave, jsonb_typeof devolve NULL, e um NULL aqui faria os
  -- IF abaixo pularem o guard do LLM e a validacao por tipo inteira.
  v_conditional := COALESCE(pg_catalog.jsonb_typeof(v_field->'condition') = 'object', false);
  -- O vazio canonico do tipo, o unico branco que se grava, para que export e
  -- Gabarito leiam um unico vazio por tipo. Definicao sem `type` cai no "".
  v_blank := CASE WHEN v_field->>'type' = 'multi' THEN '[]'::JSONB ELSE '""'::JSONB END;
  -- O LLM em branco no sentido de `isBlankAnswer`: sem a chave, null, [] ou
  -- texto so de espaco no sentido do trim() do JS. btrim tira so o espaco
  -- comum, e [[:space:]] depende da localidade e deixa NBSP e U+FEFF de fora:
  -- a classe e explicita.
  v_llm_blank := NOT (v_context->'llm_value'->>'present')::BOOLEAN
    OR COALESCE(pg_catalog.jsonb_typeof(v_context->'llm_value'->'value') = 'null'
                OR v_context->'llm_value'->'value' = '[]'::JSONB
                OR (pg_catalog.jsonb_typeof(v_context->'llm_value'->'value') = 'string'
                    AND (v_context->'llm_value'->>'value')
                      ~ E'^[\t\n\u000B\f\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*$'), false);

  -- O valor comum de "Ambos corretos", conferido contra o contexto.
  IF v_common IS NOT NULL THEN
    -- Na auto-revisao o veredito e a propria resposta humana do contexto, e
    -- ela nao fica para tras.
    IF v_context->'source'->>'kind' IS DISTINCT FROM 'comparacao' THEN
      RAISE EXCEPTION 'Só o veredito da Comparação dá lugar ao valor comum.' USING ERRCODE = '22023';
    END IF;
    -- A arbitragem escolheu a propria resposta do LLM: o veredito ja e ela.
    IF v_context->'source'->>'chosen_response_id' IS NOT DISTINCT FROM v_context->>'llm_response_id' THEN
      RAISE EXCEPTION 'O veredito já é a resposta do LLM: não há valor comum.' USING ERRCODE = '22023';
    END IF;
    IF v_llm_blank AND NOT v_conditional THEN
      RAISE EXCEPTION 'Fora de pergunta condicional, o branco não é resposta: não há valor comum.' USING ERRCODE = '22023';
    END IF;
    -- 40001: com cliente honesto, so acontece se a resposta do LLM mudou
    -- entre a carga da fila e o contexto.
    IF v_common IS DISTINCT FROM (CASE WHEN v_llm_blank THEN v_blank ELSE v_context->'llm_value'->'value' END) THEN
      RAISE EXCEPTION 'O valor comum é a resposta do LLM, que mudou. Recarregue antes de confirmar.' USING ERRCODE = '40001';
    END IF;
    v_problem := CASE WHEN NOT v_llm_blank THEN public.error_resolution_value_problem(v_field, v_common) END;
    IF v_problem IS NOT NULL THEN
      RAISE EXCEPTION '%', v_problem USING ERRCODE = '22023';
    END IF;
  END IF;

  IF ((p_decision = 'both_correct' AND v_common IS NULL) OR (p_decision = 'llm_correct' AND NOT v_conditional))
    AND NOT (v_context->'llm_value'->>'present')::BOOLEAN
    THEN RAISE EXCEPTION 'A resposta do LLM não contém este campo.' USING ERRCODE = '22023'; END IF;

  -- "Erro do LLM" e "Todos errados": o valor aprovado e escolhido pelo revisor nas opcoes atuais
  -- do campo. A resposta humana do contexto e so ancora de invalidacao, nao a
  -- origem do valor, por isso nao se exige mais que ela contenha o campo.
  IF p_decision IN ('researchers_correct', 'all_wrong') THEN
    IF p_value IS NULL OR pg_catalog.jsonb_typeof(p_value) = 'null' THEN
      RAISE EXCEPTION 'Escolha o valor que vai ao gabarito.' USING ERRCODE = '22023';
    END IF;
    -- Em pergunta condicional, o vazio canonico do tipo e resposta: diz ao
    -- gabarito que o gatilho nao acionou a pergunta. Com o LLM tambem em
    -- branco, o branco nao e erro dele e a decisao e "Erro humano": gravar
    -- aqui contaria erro onde o Gabarito marca acerto.
    IF v_conditional AND p_value = v_blank THEN
      IF v_llm_blank THEN
        RAISE EXCEPTION 'O LLM também deixou em branco: a decisão é "Erro humano".' USING ERRCODE = '22023';
      END IF;
    ELSE
      v_problem := public.error_resolution_value_problem(v_field, p_value);
      IF v_problem IS NOT NULL THEN
        RAISE EXCEPTION '%', v_problem USING ERRCODE = '22023';
      END IF;
    END IF;
  END IF;

  INSERT INTO public.error_resolutions (project_id, document_id, field_name, decision, context, approved_value, resolved_by, resolved_at, note)
  VALUES (p_project_id, p_document_id, p_field_name, p_decision, v_context,
    CASE WHEN p_decision IN ('researchers_correct', 'all_wrong') THEN p_value
         WHEN p_decision = 'both_correct' THEN v_common END,
    v_actor, pg_catalog.clock_timestamp(), NULLIF(pg_catalog.btrim(p_note), ''))
  ON CONFLICT (project_id, document_id, field_name) DO UPDATE
    SET decision = EXCLUDED.decision, context = EXCLUDED.context, approved_value = EXCLUDED.approved_value,
        resolved_by = EXCLUDED.resolved_by, resolved_at = EXCLUDED.resolved_at, note = EXCLUDED.note
  RETURNING * INTO v_saved;
  RETURN pg_catalog.to_jsonb(v_saved);
END $$;

COMMIT;
