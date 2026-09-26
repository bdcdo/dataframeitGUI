-- Decisao do LLM Insights ancorada em veredito que perdeu a validade (#758).
--
-- `llm_error_context` lia a review de origem so por id: deixava abrir, e
-- redecidir, uma decisao sobre veredito dado para outra versao da pergunta,
-- e `read_error_resolutions` mantinha essa decisao valendo no Gabarito, no
-- export e na fila. A validade do veredito e a de 20260926120000
-- (`review_is_valid`).
--
-- A regra nao e "toda decisao exige fonte valida". Ela depende do que a
-- decisao grava:
--   * "Erro humano", "Erro do LLM" e "Todos errados" gravam valor proprio (a
--     resposta do LLM ou `approved_value`). Sao um julgamento novo, feito sobre
--     as respostas `is_latest` e a `field_definition` atuais, que o contexto ja
--     confere. Valem mesmo que o veredito que motivou o card esteja invalido.
--   * "Ambos corretos" e "Em discussao" nao gravam valor: o gabarito continua
--     sendo o veredito da fonte. Caem quando a fonte e invalida.
--
-- Por isso `llm_error_context` ganha `p_require_valid_source`, com default
-- `true`, e os tres chamadores passam a regra da decisao:
--   * `read_error_resolutions` AVALIA decisao ja gravada e so exige a fonte
--     das decisoes que nao gravam valor; a decisao com valor ja gravada nao
--     fica stale por isso;
--   * `prepareErrorResolution` (RPC do cliente) pede o contexto com o flag da
--     decisao que o revisor vai confirmar, e `set_error_resolution` o
--     recalcula com o mesmo flag. Sobre veredito invalido, as decisoes com
--     valor proprio podem ser redecididas entre si (a decisao ressuscitada
--     nao fica presa na fila sem saida), e nenhuma decisao nova que dependa
--     da fonte e gravada: `set_error_resolution` a recusa com mensagem
--     propria (22023). "Reabrir" nao passa pelo contexto e continua valendo.
-- O corpo de `set_error_resolution` abaixo e o de
-- 20260924120000_error_resolutions_resposta_em_branco.sql com a guarda da
-- fonte e o oitavo argumento de `llm_error_context`; a assinatura nao muda,
-- entao `OR REPLACE` preserva os grants.
--
-- A copia TypeScript da regra de aplicacao e `decisionDependsOnSource` em
-- `frontend/src/lib/error-resolution.ts`, usada pela fila, pelo Gabarito e
-- pelo export.
--
-- Parametro novo e funcao nova: a antiga e derrubada antes (senao o PostgREST
-- veria duas sobrecargas e a chamada de 7 argumentos seria ambigua) e os grants
-- sao reemitidos. O corpo e o de 20260918130000 com a guarda depois do SELECT
-- da review. `read_error_resolutions` mantem assinatura e grants.

BEGIN;

DROP FUNCTION public.llm_error_context(UUID, UUID, TEXT, UUID, UUID, TEXT, UUID);

CREATE FUNCTION public.llm_error_context(
  p_project_id UUID, p_document_id UUID, p_field_name TEXT,
  p_llm_response_id UUID, p_human_response_id UUID, p_source_kind TEXT, p_source_id UUID,
  p_require_valid_source BOOLEAN DEFAULT true
) RETURNS JSONB
-- A validade de uma decisão concluída não depende de quem participou da arbitragem.
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_project public.projects%ROWTYPE;
  v_llm public.responses%ROWTYPE;
  v_human public.responses%ROWTYPE;
  v_review public.reviews%ROWTYPE;
  v_self public.field_reviews%ROWTYPE;
  v_field JSONB;
  v_source JSONB;
  v_llm_value JSONB;
  v_human_value JSONB;
BEGIN
  IF public.clerk_uid() IS NULL OR NOT COALESCE((
    p_project_id IN (SELECT public.auth_user_project_ids())
    OR p_project_id IN (SELECT public.auth_user_coordinator_or_creator_project_ids()) OR public.is_master()
  ), false) THEN RETURN NULL; END IF;
  SELECT * INTO v_project FROM public.projects WHERE id = p_project_id;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.documents WHERE id = p_document_id AND project_id = p_project_id
      AND excluded_at IS NULL AND exclusion_pending_at IS NULL
  ) THEN RETURN NULL; END IF;
  SELECT field INTO v_field FROM pg_catalog.jsonb_array_elements(v_project.pydantic_fields) AS field
    WHERE field->>'name' = p_field_name;
  IF v_field IS NULL OR COALESCE(v_field->>'target', 'all') <> 'all' THEN RETURN NULL; END IF;

  SELECT * INTO v_llm FROM public.responses WHERE id = p_llm_response_id
    AND project_id = p_project_id AND document_id = p_document_id
    AND respondent_type = 'llm' AND is_latest
    AND round_id IS NOT DISTINCT FROM v_project.current_round_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO v_human FROM public.responses WHERE id = p_human_response_id
    AND project_id = p_project_id AND document_id = p_document_id
    AND respondent_type = 'humano' AND is_latest
    AND round_id IS NOT DISTINCT FROM v_project.current_round_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_llm_value := v_llm.answers->p_field_name;
  v_human_value := v_human.answers->p_field_name;

  IF p_source_kind = 'comparacao' THEN
    SELECT * INTO v_review FROM public.reviews WHERE id = p_source_id
      AND project_id = p_project_id AND document_id = p_document_id AND field_name = p_field_name;
    IF NOT FOUND THEN RETURN NULL; END IF;
    -- Veredito dado sobre outra versao da pergunta, ou fora do dominio atual.
    IF p_require_valid_source AND NOT public.review_is_valid(v_review.id) THEN RETURN NULL; END IF;
    v_source := pg_catalog.jsonb_build_object('kind', p_source_kind, 'id', v_review.id,
      'verdict', v_review.verdict, 'chosen_response_id', v_review.chosen_response_id,
      'response_snapshot', v_review.response_snapshot, 'comment', v_review.comment);
  ELSIF p_source_kind = 'auto_revisao' AND v_project.automation_mode = 'auto_review_llm' THEN
    SELECT * INTO v_self FROM public.field_reviews WHERE id = p_source_id
      AND project_id = p_project_id AND document_id = p_document_id AND field_name = p_field_name
      AND human_response_id = v_human.id AND llm_response_id = v_llm.id AND superseded_at IS NULL;
    IF NOT FOUND OR v_self.final_verdict IS NULL OR
      public.is_auto_review_reconciliation_pending(p_project_id, p_document_id, v_llm.id)
      OR v_self.llm_answer_snapshot IS DISTINCT FROM v_llm_value
      OR v_self.human_answer_snapshot IS DISTINCT FROM v_human_value
    THEN RETURN NULL; END IF;
    v_llm_value := v_self.llm_answer_snapshot;
    v_human_value := v_self.human_answer_snapshot;
    v_source := pg_catalog.jsonb_build_object('kind', p_source_kind, 'id', v_self.id,
      'cycle_no', v_self.cycle_no, 'self_verdict', v_self.self_verdict,
      'final_verdict', v_self.final_verdict, 'final_decided_at', v_self.final_decided_at,
      'arbitrator_comment', v_self.arbitrator_comment);
  ELSE RETURN NULL;
  END IF;

  -- O hash cobre condicionantes sem repetir a resposta inteira em cada decisão de campo.
  v_source := v_source || pg_catalog.jsonb_build_object(
    'responses_hash', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_object('llm', v_llm.answers, 'human', v_human.answers,
        'llm_field_hashes', v_llm.answer_field_hashes, 'human_field_hashes', v_human.answer_field_hashes,
        'llm_justifications', v_llm.justifications, 'human_justifications', v_human.justifications)::TEXT,
      'UTF8')), 'hex'),
    'reviews', (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', r.id, 'verdict', r.verdict, 'chosen_response_id', r.chosen_response_id,
      'comment', r.comment, 'response_snapshot', r.response_snapshot) ORDER BY r.id), '[]'::JSONB)
      FROM public.reviews r WHERE r.project_id = p_project_id AND r.document_id = p_document_id AND r.field_name = p_field_name),
    'auto_reviews', (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', fr.id, 'cycle_no', fr.cycle_no, 'final_verdict', fr.final_verdict,
      'final_decided_at', fr.final_decided_at) ORDER BY fr.id), '[]'::JSONB)
      FROM public.field_reviews fr WHERE fr.project_id = p_project_id AND fr.document_id = p_document_id
        AND fr.field_name = p_field_name AND fr.superseded_at IS NULL));
  RETURN pg_catalog.jsonb_build_object(
    'project_id', p_project_id, 'document_id', p_document_id, 'field_name', p_field_name,
    'round_id', v_project.current_round_id, 'automation_mode', v_project.automation_mode,
    'field_definition', v_field, 'llm_response_id', v_llm.id, 'human_response_id', v_human.id,
    'llm_value', pg_catalog.jsonb_build_object('present', v_llm.answers ? p_field_name, 'value', v_llm_value),
    'human_value', pg_catalog.jsonb_build_object('present', v_human.answers ? p_field_name, 'value', v_human_value),
    'source', v_source);
END $$;

REVOKE ALL ON FUNCTION public.llm_error_context(UUID, UUID, TEXT, UUID, UUID, TEXT, UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.llm_error_context(UUID, UUID, TEXT, UUID, UUID, TEXT, UUID, BOOLEAN) TO authenticated, service_role;

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
  v_conditional BOOLEAN;
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

  -- Decisao que depende do veredito da fonte ("Ambos corretos", "Em
  -- discussao") nao nasce sobre veredito que perdeu a validade. A mensagem
  -- propria existe porque o NULL do contexto abaixo mandaria recarregar uma
  -- pagina que nao vai mudar. A lista e a das decisoes com valor proprio,
  -- como em `read_error_resolutions`, para que um tipo novo nasca exigindo a
  -- fonte.
  v_requires_source := p_decision NOT IN ('llm_correct', 'researchers_correct', 'all_wrong');
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
  IF v_context IS NULL OR v_context IS DISTINCT FROM p_expected_context THEN
    RAISE EXCEPTION 'As respostas mudaram. Recarregue antes de confirmar.' USING ERRCODE = '40001';
  END IF;
  v_field := v_context->'field_definition';
  -- COALESCE: sem a chave, jsonb_typeof devolve NULL, e um NULL aqui faria os
  -- IF abaixo pularem o guard do LLM e a validacao por tipo inteira.
  v_conditional := COALESCE(pg_catalog.jsonb_typeof(v_field->'condition') = 'object', false);
  IF (p_decision = 'both_correct' OR (p_decision = 'llm_correct' AND NOT v_conditional))
    AND NOT (v_context->'llm_value'->>'present')::BOOLEAN
    THEN RAISE EXCEPTION 'A resposta do LLM não contém este campo.' USING ERRCODE = '22023'; END IF;

  -- "Erro do LLM" e "Todos errados": o valor aprovado e escolhido pelo revisor nas opcoes atuais
  -- do campo. A resposta humana do contexto e so ancora de invalidacao, nao a
  -- origem do valor, por isso nao se exige mais que ela contenha o campo.
  IF p_decision IN ('researchers_correct', 'all_wrong') THEN
    v_type := v_field->>'type';
    v_options := CASE WHEN pg_catalog.jsonb_typeof(v_field->'options') = 'array'
      THEN v_field->'options' ELSE '[]'::JSONB END;
    v_allow_other := COALESCE((v_field->>'allow_other')::BOOLEAN, false);
    v_has_subfields := pg_catalog.jsonb_typeof(v_field->'subfields') = 'array'
      AND pg_catalog.jsonb_array_length(v_field->'subfields') > 0;
    IF p_value IS NULL OR pg_catalog.jsonb_typeof(p_value) = 'null' THEN
      RAISE EXCEPTION 'Escolha o valor que vai ao gabarito.' USING ERRCODE = '22023';
    END IF;
    -- Em pergunta condicional, o vazio canonico do tipo e resposta: diz ao
    -- gabarito que o gatilho nao acionou a pergunta. So a forma exata, para
    -- que export e Gabarito leiam um unico vazio por tipo. Com o LLM tambem
    -- em branco (sem a chave, null, "" ou []), o branco nao e erro dele e a
    -- decisao e "Erro humano": gravar aqui contaria erro onde o Gabarito marca
    -- acerto. COALESCE de novo: definicao sem `type` deixaria o teste de multi
    -- em NULL.
    IF v_conditional AND ((COALESCE(v_type = 'multi', false) AND p_value = '[]'::JSONB)
                          OR (v_type IS DISTINCT FROM 'multi' AND p_value = '""'::JSONB)) THEN
      IF NOT (v_context->'llm_value'->>'present')::BOOLEAN
        OR COALESCE(pg_catalog.jsonb_typeof(v_context->'llm_value'->'value') = 'null'
                    OR v_context->'llm_value'->'value' = '[]'::JSONB
                    -- Texto so de espaco no sentido do trim() do JS, que e o que
                    -- isBlankAnswer usa no Gabarito e na metrica. btrim tira so
                    -- o espaco comum, e [[:space:]] depende da localidade e
                    -- deixa NBSP e U+FEFF de fora: a classe e explicita.
                    OR (pg_catalog.jsonb_typeof(v_context->'llm_value'->'value') = 'string'
                        AND (v_context->'llm_value'->>'value')
                          ~ E'^[\t\n\u000B\f\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*$'), false) THEN
        RAISE EXCEPTION 'O LLM também deixou em branco: a decisão é "Erro humano".' USING ERRCODE = '22023';
      END IF;
    ELSE
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

-- Avaliacao de decisao gravada: so as que nao gravam valor dependem da fonte.
-- A lista e a das decisoes com valor, e nao a das sem valor, para que um tipo
-- de decisao futuro nasca exigindo a fonte (fail-closed).
CREATE OR REPLACE FUNCTION public.read_error_resolutions(p_project_id UUID)
RETURNS TABLE(id UUID, project_id UUID, document_id UUID, field_name TEXT, decision TEXT,
  context JSONB, current_context JSONB, resolved_at TIMESTAMPTZ, resolved_by UUID, note TEXT, approved_value JSONB)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT r.id, r.project_id, r.document_id, r.field_name, r.decision, r.context,
    CASE WHEN r.context IS NOT NULL THEN public.llm_error_context(
      r.project_id, r.document_id, r.field_name,
      (r.context->>'llm_response_id')::UUID, (r.context->>'human_response_id')::UUID,
      r.context->'source'->>'kind', (r.context->'source'->>'id')::UUID,
      r.decision IS DISTINCT FROM 'llm_correct'
        AND r.decision IS DISTINCT FROM 'researchers_correct'
        AND r.decision IS DISTINCT FROM 'all_wrong') END,
    r.resolved_at, r.resolved_by, r.note, r.approved_value
  FROM public.error_resolutions r WHERE r.project_id = p_project_id
$$;

COMMIT;
