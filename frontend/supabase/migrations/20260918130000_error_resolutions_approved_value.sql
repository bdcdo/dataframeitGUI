-- "Erro do LLM" leva o veredito, nas opcoes atuais do campo; a decisao so
-- invalida quando a propria pergunta muda (#733).
--
-- Tres defeitos do #730, medidos em 2026-09-18 num projeto de producao:
--
-- 1. `researchers_correct` gravava como valor aprovado a resposta de um
--    codificador (`context.human_value`), escolhida num passo "qual resposta
--    humana", enquanto o card comparava o LLM com o veredito da arbitragem
--    (`source.verdict`). Quando a arbitragem tinha rejeitado os codificadores,
--    o veredito nao estava em botao nenhum. Agora o valor aprovado e escolhido
--    pelo revisor entre as opcoes atuais da pergunta e vive em
--    `approved_value`, validado aqui contra `field_definition`.
--
-- 2. O contexto carregava `projects.schema_revision`, que sobe em QUALQUER
--    save de schema. Editar a descricao de uma pergunta marcava todas as
--    decisoes do projeto como "Fontes alteradas" e as tirava do export.
--    `field_definition` ja esta no contexto e basta para invalidar quando a
--    propria pergunta muda; `schema_revision` sai de `source`, e os contextos
--    ja gravados sao recarimbados sem a chave para continuarem validos.
--
-- 3. Sob a semantica nova, uma decisao "Erro do LLM" cujo valor gravado nao e
--    o veredito da fonte nao e expressavel. Ela vira "Em discussao" com uma
--    nota que guarda o valor gravado e o veredito, para o revisor decidir de
--    novo com o seletor: nenhuma linha e apagada (docs/VERIFICATION.md, reparo
--    de dado). A regra vive em `error_resolution_diverges_from_verdict`, uma
--    funcao pura testada em llm_error_decisions.test.sql sobre fixtures, ja
--    que os testes rodam depois das migrations e nao veem linha legada. Ela so
--    afirma divergencia quando pode prova-la: fonte `comparacao`, campo sem
--    subcampos (o veredito de grupo e texto renderizado), `multi` por conjunto
--    (veredito JSON `{opcao: bool}` contra o array gravado) e os demais por
--    `btrim`. Auto-revisao nunca diverge: `final_verdict` diz o LADO que
--    venceu ('humano'/'llm'), e o card mostra o snapshot humano, que o
--    contexto exige igual a `human_value`. A contagem sai em NOTICE; a medicao
--    em producao vai no PR.
--
-- `set_error_resolution` e `read_error_resolutions` mudam de assinatura, e
-- assinatura nova e funcao nova: as antigas sao derrubadas antes (senao o
-- PostgREST veria duas sobrecargas) e os grants sao reemitidos, porque morrem
-- com a funcao. O corpo de `llm_error_context` fica byte-identico ao do #730
-- menos a linha de `schema_revision`; a assinatura nao muda.
--
-- A validacao por tipo e regra duplicada em duas fronteiras, de proposito: o
-- cliente (`hasResolutionValue`) desabilita o botao, e esta RPC recusa o que
-- chegar fora do dominio do campo. `single`: uma opcao; `multi`: array nao
-- vazio de opcoes; com `allow_other`, texto fora das opcoes so na forma que o
-- FieldRenderer produz, "Outro: " com complemento (o prefixo e copia
-- deliberada de other-option.ts, testada dos dois lados); `text` com
-- subcampos: objeto so com chaves conhecidas e algum valor, ou a sentinela
-- textual; `date`: o formato parcial DD/MM/AAAA ou sentinela; demais: texto
-- nao vazio.

BEGIN;

ALTER TABLE public.error_resolutions
  ADD COLUMN approved_value JSONB;

-- 3. Divergencia entre o valor gravado e o veredito da fonte. Funcao pura,
-- IMMUTABLE, sem acesso a tabela: testavel com um JSON por caso.
CREATE FUNCTION public.error_resolution_diverges_from_verdict(p_context JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_field JSONB := p_context->'field_definition';
  v_human JSONB := p_context->'human_value'->'value';
  v_verdict TEXT := p_context->'source'->>'verdict';
  v_human_set TEXT[];
  v_verdict_set TEXT[];
BEGIN
  IF p_context->'source'->>'kind' IS DISTINCT FROM 'comparacao' THEN RETURN false; END IF;
  IF v_field->>'type' = 'text'
     AND pg_catalog.jsonb_typeof(v_field->'subfields') = 'array'
     AND pg_catalog.jsonb_array_length(v_field->'subfields') > 0 THEN
    RETURN false;
  END IF;
  IF v_field->>'type' = 'multi' THEN
    SELECT COALESCE(array_agg(DISTINCT item ORDER BY item), '{}') INTO v_human_set
    FROM pg_catalog.jsonb_array_elements_text(
      CASE WHEN pg_catalog.jsonb_typeof(v_human) = 'array' THEN v_human ELSE '[]'::JSONB END) AS item;
    BEGIN
      SELECT COALESCE(array_agg(DISTINCT pair.key ORDER BY pair.key), '{}') INTO v_verdict_set
      FROM pg_catalog.jsonb_each(v_verdict::JSONB) AS pair
      WHERE pair.value = 'true'::JSONB;
    EXCEPTION WHEN OTHERS THEN
      -- Veredito que nao e o JSON de multi: sem prova de divergencia, mantem.
      RETURN false;
    END;
    RETURN v_human_set IS DISTINCT FROM v_verdict_set;
  END IF;
  -- Opcao de formulario carrega espaco final; o veredito nem sempre.
  RETURN pg_catalog.btrim(COALESCE(v_human #>> '{}', ''))
    IS DISTINCT FROM pg_catalog.btrim(COALESCE(v_verdict, ''));
END;
$$;

REVOKE ALL ON FUNCTION public.error_resolution_diverges_from_verdict(JSONB)
  FROM PUBLIC, anon, authenticated, service_role;

-- A decisao divergente vira "Em discussao" com nota: a celula fica sem valor
-- aprovado (como toda discussao), o revisor a reve na fila, e o que estava
-- gravado continua legivel. `resolved_at` fica: a data da reabertura esta na
-- nota, e a identidade (id, resolved_at) que a UI usa no compare-and-swap
-- continua valendo.
DO $$
DECLARE
  v_count INT;
BEGIN
  UPDATE public.error_resolutions
  SET decision = 'discussion',
      note = 'Reaberta em ' || pg_catalog.to_char(pg_catalog.now(), 'DD/MM/YYYY') || ': o valor gravado ('
        || COALESCE(context->'human_value'->>'value', '')
        || ') difere do veredito anterior ('
        || COALESCE(context->'source'->>'verdict', '')
        || '). Decida de novo com o seletor.'
        || CASE WHEN NULLIF(pg_catalog.btrim(note), '') IS NOT NULL
             THEN ' Nota anterior: ' || note ELSE '' END
  WHERE decision = 'researchers_correct' AND context IS NOT NULL
    AND public.error_resolution_diverges_from_verdict(context);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'error_resolutions: % decisao(oes) "Erro do LLM" com valor gravado diferente do veredito viraram "Em discussao" com nota',
    v_count;
END $$;

-- 1. As que sobraram tem valor gravado igual ao veredito: materializar.
UPDATE public.error_resolutions
SET approved_value = context->'human_value'->'value'
WHERE decision = 'researchers_correct' AND context IS NOT NULL;

-- 2. Recarimbar os contextos sem `schema_revision`, para que continuem iguais
-- ao que `llm_error_context` passa a devolver.
UPDATE public.error_resolutions
SET context = context #- '{source,schema_revision}'
WHERE context IS NOT NULL;

-- `llm_correct` deriva o valor de `context.llm_value` (a resposta do LLM,
-- protegida pela invalidacao); `discussion` e legado nao tem valor.
ALTER TABLE public.error_resolutions
  ADD CONSTRAINT error_resolution_value_iff_researchers
  CHECK ((decision IS NOT DISTINCT FROM 'researchers_correct') = (approved_value IS NOT NULL));

CREATE OR REPLACE FUNCTION public.llm_error_context(
  p_project_id UUID, p_document_id UUID, p_field_name TEXT,
  p_llm_response_id UUID, p_human_response_id UUID, p_source_kind TEXT, p_source_id UUID
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

DROP FUNCTION public.set_error_resolution(UUID, UUID, TEXT, TEXT, JSONB, UUID, TIMESTAMPTZ, TEXT);
CREATE FUNCTION public.set_error_resolution(
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
  IF p_decision IS NOT NULL AND p_decision NOT IN ('llm_correct', 'researchers_correct', 'discussion')
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
  IF p_decision = 'llm_correct' AND NOT (v_context->'llm_value'->>'present')::BOOLEAN
    THEN RAISE EXCEPTION 'A resposta do LLM não contém este campo.' USING ERRCODE = '22023'; END IF;

  -- "Erro do LLM": o valor aprovado e escolhido pelo revisor nas opcoes atuais
  -- do campo. A resposta humana do contexto e so ancora de invalidacao, nao a
  -- origem do valor, por isso nao se exige mais que ela contenha o campo.
  IF p_decision = 'researchers_correct' THEN
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
    CASE WHEN p_decision = 'researchers_correct' THEN p_value END,
    v_actor, pg_catalog.clock_timestamp(), NULLIF(pg_catalog.btrim(p_note), ''))
  ON CONFLICT (project_id, document_id, field_name) DO UPDATE
    SET decision = EXCLUDED.decision, context = EXCLUDED.context, approved_value = EXCLUDED.approved_value,
        resolved_by = EXCLUDED.resolved_by, resolved_at = EXCLUDED.resolved_at, note = EXCLUDED.note
  RETURNING * INTO v_saved;
  RETURN pg_catalog.to_jsonb(v_saved);
END $$;

-- `RETURNS TABLE` nao aceita coluna nova por `OR REPLACE`.
DROP FUNCTION public.read_error_resolutions(UUID);
CREATE FUNCTION public.read_error_resolutions(p_project_id UUID)
RETURNS TABLE(id UUID, project_id UUID, document_id UUID, field_name TEXT, decision TEXT,
  context JSONB, current_context JSONB, resolved_at TIMESTAMPTZ, resolved_by UUID, note TEXT, approved_value JSONB)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT r.id, r.project_id, r.document_id, r.field_name, r.decision, r.context,
    CASE WHEN r.context IS NOT NULL THEN public.llm_error_context(
      r.project_id, r.document_id, r.field_name,
      (r.context->>'llm_response_id')::UUID, (r.context->>'human_response_id')::UUID,
      r.context->'source'->>'kind', (r.context->'source'->>'id')::UUID) END,
    r.resolved_at, r.resolved_by, r.note, r.approved_value
  FROM public.error_resolutions r WHERE r.project_id = p_project_id
$$;

REVOKE ALL ON FUNCTION public.read_error_resolutions(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_error_resolution(UUID, UUID, TEXT, TEXT, JSONB, UUID, TIMESTAMPTZ, TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.read_error_resolutions(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_error_resolution(UUID, UUID, TEXT, TEXT, JSONB, UUID, TIMESTAMPTZ, TEXT, JSONB) TO authenticated, service_role;

COMMIT;
