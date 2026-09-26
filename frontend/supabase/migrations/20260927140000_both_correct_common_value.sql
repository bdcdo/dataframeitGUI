-- "Ambos corretos" grava o valor comum quando o veredito ficou para tras (#758).
--
-- Caso de producao: na fila do LLM Insights, o "Veredito anterior" de varias
-- celulas vinha de uma arbitragem antiga que dizia X, enquanto os
-- pesquisadores da rodada atual e o LLM diziam Y. "Ambos corretos" significava
-- "o LLM e o veredito anterior estao certos": nao gravava valor e deixava X no
-- Gabarito. Quem revisava concordava com Y e so tinha "Erro humano" para
-- gravar Y, o que conta um erro humano que nao existiu.
--
-- Regra nova: "Ambos corretos" pode gravar em `approved_value` o valor comum,
-- que e a resposta do LLM (em pergunta condicional com o LLM em branco, o
-- branco canonico do tipo, "" ou []). Quem decide se ha valor comum e a fila
-- (`bothCorrectCommonValue` em llm-error-metrics.ts): o veredito da Comparacao
-- diverge da resposta do LLM pela regra da metrica, e todo pesquisador
-- corrente concorda com ela, por texto normalizado ou por par "=" vigente.
-- Sem valor comum, "Ambos corretos" segue como antes e o veredito vale.
--
-- `set_error_resolution` confere so o que o contexto da decisao prova: fonte
-- Comparacao, resposta escolhida no veredito diferente da do LLM, valor igual
-- a resposta do LLM do contexto (ou o branco canonico de condicional com o LLM
-- em branco) e valor no dominio atual do campo. Se os demais pesquisadores
-- concordam, o servidor nao confere: dos pesquisadores o contexto guarda so o
-- hash das codificacoes (`cell_answers_hash`, de 20260927130000), que nao se
-- le de volta, e os pares "=" nao estao nele. O que isso deixa aberto e so a
-- contagem de erro: o valor gravado e a resposta do LLM, a mesma que "Erro
-- humano" gravaria, e quem pode chamar o RPC ja pode grava-la por la. Depois
-- de gravada, a decisao cai (fica stale) quando um pesquisador muda de
-- resposta, porque o hash muda e o contexto recalculado deixa de ser igual ao
-- guardado; a criacao ou remocao de um par "=" sozinha nao a derruba.
--
-- Com valor proprio, "Ambos corretos" deixa de depender da fonte, como as
-- demais decisoes com valor: `read_error_resolutions` so exige veredito valido
-- das decisoes sem valor, e `set_error_resolution` so recusa sobre veredito
-- invalido as decisoes sem valor. A copia TypeScript e
-- `decisionDependsOnSource`.
--
-- CHECK: `error_resolution_value_iff_chosen` vira
-- `error_resolution_value_by_decision`: valor obrigatorio em "Erro do LLM" e
-- "Todos errados", opcional (e nunca JSON null) em "Ambos corretos", proibido
-- nas demais. "So quando a fonte diverge" depende do texto do veredito e fica
-- na invariante `ambos-corretos-com-valor-so-com-fonte-divergente`.

BEGIN;

-- ── Dominio do valor aprovado ─────────────────────────────────────────────

-- A validacao por tipo que `set_error_resolution` fazia em linha para "Erro do
-- LLM" e "Todos errados", extraida sem mudar regra nem mensagem para servir
-- tambem ao valor comum. NULL quando o valor cabe; senao, a mensagem.
CREATE FUNCTION public.error_resolution_value_problem(p_field JSONB, p_value JSONB)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  v_type TEXT := p_field->>'type';
  v_options JSONB := CASE WHEN pg_catalog.jsonb_typeof(p_field->'options') = 'array'
    THEN p_field->'options' ELSE '[]'::JSONB END;
  v_allow_other BOOLEAN := COALESCE((p_field->>'allow_other')::BOOLEAN, false);
  v_has_subfields BOOLEAN := pg_catalog.jsonb_typeof(p_field->'subfields') = 'array'
    AND pg_catalog.jsonb_array_length(p_field->'subfields') > 0;
BEGIN
  IF p_value IS NULL OR pg_catalog.jsonb_typeof(p_value) = 'null' THEN
    RETURN 'Escolha o valor que vai ao gabarito.';
  END IF;
  -- Fora das opcoes so entra o "Outro: <texto>" que o FieldRenderer grava,
  -- e so quando o campo permite; o prefixo sem complemento e resposta
  -- incompleta (other-option.ts, `isIncompleteOther`).
  IF v_type = 'single' THEN
    IF pg_catalog.jsonb_typeof(p_value) <> 'string' OR pg_catalog.btrim(p_value #>> '{}') = ''
      OR NOT (v_options @> pg_catalog.jsonb_build_array(p_value)
              OR (v_allow_other AND (p_value #>> '{}') ~ '^Outro: .*\S')) THEN
      RETURN 'O valor precisa ser uma das opções da pergunta.';
    END IF;
  ELSIF v_type = 'multi' THEN
    IF pg_catalog.jsonb_typeof(p_value) <> 'array' OR pg_catalog.jsonb_array_length(p_value) = 0
      OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(p_value) AS item
                 WHERE pg_catalog.jsonb_typeof(item) <> 'string'
                    OR NOT (v_options @> pg_catalog.jsonb_build_array(item)
                            OR (v_allow_other AND (item #>> '{}') ~ '^Outro: .*\S'))) THEN
      RETURN 'Marque ao menos uma opção da pergunta.';
    END IF;
  ELSIF v_type = 'text' AND v_has_subfields AND pg_catalog.jsonb_typeof(p_value) = 'object' THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_object_keys(p_value) AS object_key
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(p_field->'subfields') AS subfield
        WHERE subfield->>'key' = object_key)
    ) OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_each(p_value) AS pair
      WHERE pg_catalog.jsonb_typeof(pair.value) = 'string' AND pg_catalog.btrim(pair.value #>> '{}') <> ''
    ) THEN
      RETURN 'Preencha ao menos um subcampo da pergunta, sem subcampo desconhecido.';
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
      RETURN 'Informe a data no formato DD/MM/AAAA ou uma das opções.';
    END IF;
  ELSIF pg_catalog.jsonb_typeof(p_value) <> 'string' OR pg_catalog.btrim(p_value #>> '{}') = '' THEN
    -- Texto simples e a sentinela textual de um grupo de subcampos.
    RETURN 'Informe o valor que vai ao gabarito.';
  END IF;
  RETURN NULL;
END;
$$;

-- ── CHECK ─────────────────────────────────────────────────────────────────

ALTER TABLE public.error_resolutions
  DROP CONSTRAINT error_resolution_value_iff_chosen,
  ADD CONSTRAINT error_resolution_value_by_decision CHECK (
    CASE
      WHEN decision IN ('researchers_correct', 'all_wrong') THEN approved_value IS NOT NULL
      WHEN decision = 'both_correct' THEN approved_value IS NULL OR pg_catalog.jsonb_typeof(approved_value) <> 'null'
      ELSE approved_value IS NULL
    END);

-- ── set_error_resolution ──────────────────────────────────────────────────

-- A de 20260926121000_llm_error_context_review_valid.sql, a definicao mais
-- recente, com quatro pontos alterados: o valor comum de "Ambos corretos"
-- (conferido contra o contexto e gravado), a guarda da fonte, que passa a
-- dispensar "Ambos corretos" com o valor comum (grava valor proprio, como em
-- `read_error_resolutions` abaixo), a exigencia de resposta do LLM em "Ambos
-- corretos" (dispensada quando ha o branco comum de condicional) e a
-- validacao por tipo, agora em `error_resolution_value_problem`. O resto e o
-- corpo de la sem mudanca: a mensagem propria da fonte invalida e o oitavo
-- argumento de `llm_error_context`, que recalcula o contexto com o mesmo
-- flag que o cliente usou ao pedi-lo. A assinatura nao muda, entao
-- `OR REPLACE` preserva os grants.
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
  IF v_context IS NULL OR v_context IS DISTINCT FROM p_expected_context THEN
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

-- ── read_error_resolutions ────────────────────────────────────────────────

-- A de 20260926121000 com um caso a mais entre as decisoes que nao dependem
-- da fonte: "Ambos corretos" com valor proprio. A lista continua sendo a das
-- decisoes com valor, para que um tipo futuro nasca exigindo a fonte.
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
        AND r.decision IS DISTINCT FROM 'all_wrong'
        AND NOT COALESCE(r.decision = 'both_correct' AND r.approved_value IS NOT NULL, false)) END,
    r.resolved_at, r.resolved_by, r.note, r.approved_value
  FROM public.error_resolutions r WHERE r.project_id = p_project_id
$$;

-- ── Grants ────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.error_resolution_value_problem(JSONB, JSONB) FROM PUBLIC, anon, authenticated;

COMMIT;
