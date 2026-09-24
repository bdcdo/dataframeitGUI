-- Duas decisoes novas na fila LLM Insights, pedidas por quem revisa:
--
-- * `both_correct` ("Ambos corretos"): a resposta do LLM e o veredito humano
--   sao aceitaveis. Nao aprova valor nenhum: o gabarito continua sendo o
--   veredito da arbitragem, e o LLM deixa de contar como erro na metrica.
--   Difere da equivalencia (`response_equivalences`), que afirma que as duas
--   respostas dizem a mesma coisa; aqui elas podem ser distintas.
-- * `all_wrong` ("Todos errados"): nem o LLM nem os pesquisadores acertaram, e
--   o revisor escolhe o valor que vai ao gabarito. Usa `approved_value` com a
--   mesma validacao por tipo de `researchers_correct`. Antes, o unico caminho
--   era marcar "Erro do LLM" com valor livre, o que registrava como acerto dos
--   pesquisadores um caso em que eles tambem erraram.
--
-- `set_error_resolution` abaixo e a da migration
-- 20260918130000_error_resolutions_approved_value.sql com quatro pontos
-- alterados: a lista de decisoes aceitas, a exigencia de que a resposta do LLM
-- contenha o campo (agora tambem em `both_correct`, que a declara correta), a
-- condicao que dispara a validacao de `p_value` e a que grava `approved_value`. A assinatura nao muda,
-- entao `OR REPLACE` preserva os grants.

BEGIN;

ALTER TABLE public.error_resolutions
  DROP CONSTRAINT error_resolutions_decision_check,
  ADD CONSTRAINT error_resolutions_decision_check
    CHECK (decision IN ('llm_correct', 'researchers_correct', 'discussion', 'both_correct', 'all_wrong'));

-- Decisoes que aprovam um valor escolhido pelo revisor carregam
-- `approved_value`; as demais, nunca.
ALTER TABLE public.error_resolutions
  DROP CONSTRAINT error_resolution_value_iff_researchers,
  ADD CONSTRAINT error_resolution_value_iff_chosen
    CHECK (((decision IN ('researchers_correct', 'all_wrong')) IS TRUE) = (approved_value IS NOT NULL));

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
  v_type TEXT;
  v_options JSONB;
  v_allow_other BOOLEAN;
  v_has_subfields BOOLEAN;
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

  v_context := public.llm_error_context(p_project_id, p_document_id, p_field_name,
    (p_expected_context->>'llm_response_id')::UUID, (p_expected_context->>'human_response_id')::UUID,
    p_expected_context->'source'->>'kind', (p_expected_context->'source'->>'id')::UUID);
  IF v_context IS NULL OR v_context IS DISTINCT FROM p_expected_context THEN
    RAISE EXCEPTION 'As respostas mudaram. Recarregue antes de confirmar.' USING ERRCODE = '40001';
  END IF;
  IF p_decision IN ('llm_correct', 'both_correct') AND NOT (v_context->'llm_value'->>'present')::BOOLEAN
    THEN RAISE EXCEPTION 'A resposta do LLM não contém este campo.' USING ERRCODE = '22023'; END IF;

  -- "Erro do LLM" e "Todos errados": o valor aprovado e escolhido pelo revisor nas opcoes atuais
  -- do campo. A resposta humana do contexto e so ancora de invalidacao, nao a
  -- origem do valor, por isso nao se exige mais que ela contenha o campo.
  IF p_decision IN ('researchers_correct', 'all_wrong') THEN
    v_field := v_context->'field_definition';
    v_type := v_field->>'type';
    v_options := CASE WHEN pg_catalog.jsonb_typeof(v_field->'options') = 'array'
      THEN v_field->'options' ELSE '[]'::JSONB END;
    v_allow_other := COALESCE((v_field->>'allow_other')::BOOLEAN, false);
    v_has_subfields := pg_catalog.jsonb_typeof(v_field->'subfields') = 'array'
      AND pg_catalog.jsonb_array_length(v_field->'subfields') > 0;
    IF p_value IS NULL OR pg_catalog.jsonb_typeof(p_value) = 'null' THEN
      RAISE EXCEPTION 'Escolha o valor que vai ao gabarito.' USING ERRCODE = '22023';
    END IF;
    -- Fora das opcoes so entra o "Outro: <texto>" que o FieldRenderer grava,
    -- e so quando o campo permite; o prefixo sem complemento e resposta
    -- incompleta (other-option.ts, `isIncompleteOther`).
    IF v_type = 'single' THEN
      IF pg_catalog.jsonb_typeof(p_value) <> 'string' OR pg_catalog.btrim(p_value #>> '{}') = ''
        OR NOT (v_options @> pg_catalog.jsonb_build_array(p_value)
                OR (v_allow_other AND (p_value #>> '{}') ~ '^Outro: .*\S')) THEN
        RAISE EXCEPTION 'O valor precisa ser uma das opções da pergunta.' USING ERRCODE = '22023';
      END IF;
    ELSIF v_type = 'multi' THEN
      IF pg_catalog.jsonb_typeof(p_value) <> 'array' OR pg_catalog.jsonb_array_length(p_value) = 0
        OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(p_value) AS item
                   WHERE pg_catalog.jsonb_typeof(item) <> 'string'
                      OR NOT (v_options @> pg_catalog.jsonb_build_array(item)
                              OR (v_allow_other AND (item #>> '{}') ~ '^Outro: .*\S'))) THEN
        RAISE EXCEPTION 'Marque ao menos uma opção da pergunta.' USING ERRCODE = '22023';
      END IF;
    ELSIF v_type = 'text' AND v_has_subfields AND pg_catalog.jsonb_typeof(p_value) = 'object' THEN
      IF EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_object_keys(p_value) AS object_key
        WHERE NOT EXISTS (
          SELECT 1 FROM pg_catalog.jsonb_array_elements(v_field->'subfields') AS subfield
          WHERE subfield->>'key' = object_key)
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_each(p_value) AS pair
        WHERE pg_catalog.jsonb_typeof(pair.value) = 'string' AND pg_catalog.btrim(pair.value #>> '{}') <> ''
      ) THEN
        RAISE EXCEPTION 'Preencha ao menos um subcampo da pergunta, sem subcampo desconhecido.' USING ERRCODE = '22023';
      END IF;
    ELSIF v_type = 'date' THEN
      -- O formato parcial de date-parts.ts (`DD/MM/AAAA`, com `XX`/`XXXX` no
      -- que o documento nao informa, e ao menos um digito), uma sentinela das
      -- opcoes do campo, ou a sentinela geral de sentinels.ts (copia
      -- deliberada). O controle de data mostra vazio o que nao parseia, entao
      -- uma string solta passaria invisivel sem esta fronteira.
      IF pg_catalog.jsonb_typeof(p_value) <> 'string'
        OR NOT (((p_value #>> '{}') ~ '^([0-9]{1,2}|XX)/([0-9]{1,2}|XX)/([0-9]{1,4}|XXXX)$'
                 AND (p_value #>> '{}') ~ '[0-9]')
                OR v_options @> pg_catalog.jsonb_build_array(p_value)
                OR (p_value #>> '{}') = 'Não informada') THEN
        RAISE EXCEPTION 'Informe a data no formato DD/MM/AAAA ou uma das opções.' USING ERRCODE = '22023';
      END IF;
    ELSIF pg_catalog.jsonb_typeof(p_value) <> 'string' OR pg_catalog.btrim(p_value #>> '{}') = '' THEN
      -- Texto simples e a sentinela textual de um grupo de subcampos.
      RAISE EXCEPTION 'Informe o valor que vai ao gabarito.' USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO public.error_resolutions (project_id, document_id, field_name, decision, context, approved_value, resolved_by, resolved_at, note)
  VALUES (p_project_id, p_document_id, p_field_name, p_decision, v_context,
    CASE WHEN p_decision IN ('researchers_correct', 'all_wrong') THEN p_value END,
    v_actor, pg_catalog.clock_timestamp(), NULLIF(pg_catalog.btrim(p_note), ''))
  ON CONFLICT (project_id, document_id, field_name) DO UPDATE
    SET decision = EXCLUDED.decision, context = EXCLUDED.context, approved_value = EXCLUDED.approved_value,
        resolved_by = EXCLUDED.resolved_by, resolved_at = EXCLUDED.resolved_at, note = EXCLUDED.note
  RETURNING * INTO v_saved;
  RETURN pg_catalog.to_jsonb(v_saved);
END $$;

COMMIT;
