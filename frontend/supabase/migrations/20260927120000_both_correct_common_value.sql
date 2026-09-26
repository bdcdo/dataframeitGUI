-- "Ambos corretos" grava o valor comum quando o veredito ficou para trás (#758).
--
-- Caso de producao: na fila do LLM Insights, o "Veredito anterior" de varias
-- celulas vinha de uma arbitragem antiga que dizia X, enquanto os
-- pesquisadores da rodada atual e o LLM diziam Y. "Ambos corretos" significava
-- "o LLM e o veredito anterior estao certos": nao gravava valor e deixava X no
-- Gabarito. Quem revisava concordava com Y e so tinha "Erro humano" para
-- gravar Y, o que conta um erro humano que nao existiu.
--
-- Regra nova: "Ambos corretos" grava em `approved_value` o valor comum quando
--   (1) a fonte e a Comparacao (na auto-revisao o veredito e a propria
--       resposta humana do contexto, e ela nao pode divergir de si mesma);
--   (2) o veredito da fonte diverge da resposta do LLM, pela mesma regra da
--       metrica (`comparisonIsError` em llm-error-metrics.ts): a resposta
--       escolhida nao e a do LLM, o veredito nao casa com a resposta do LLM,
--       nem com nenhuma resposta que um par "=" vigente liga a ela;
--   (3) toda resposta humana `is_latest` da rodada corrente concorda com a
--       do LLM (`answersAgree`: branco com branco, `multi` por conjunto, os
--       demais por `normalizeForComparison`, ou a mesma classe do union-find
--       de equivalencia que a metrica usa);
--   (4) o valor cabe no dominio atual do campo, a mesma regra de "Erro do LLM"
--       (`error_resolution_value_problem`, extraida do RPC nesta migration).
-- O valor comum e a resposta do LLM, que o contexto da decisao ja protege
-- (mudou, a decisao fica stale). Em pergunta condicional, LLM e pesquisadores
-- em branco dao o branco canonico do tipo ("" ou []); fora de condicional o
-- branco nao e resposta e nao ha valor. Quando o veredito ja concorda com o
-- LLM, nada muda: "Ambos corretos" nao grava valor.
--
-- O servidor nao confia no cliente. `set_error_resolution` calcula o valor
-- comum sobre as respostas vigentes e so aceita a decisao quando `p_value` e
-- exatamente ele (ou NULL quando nao ha); a diferenca vira 40001, "recarregue",
-- porque so acontece com respostas que mudaram entre a previa e a confirmacao
-- ou com cliente adulterado. A previa que o dialogo mostra sai da mesma funcao
-- (`both_correct_value`), entao o que o dialogo promete e o que o banco grava.
--
-- Com valor proprio, "Ambos corretos" deixa de depender da fonte, como as
-- demais decisoes com valor: `read_error_resolutions` so exige veredito valido
-- das decisoes sem valor. A copia TypeScript e `decisionDependsOnSource`.
--
-- As funcoes puras abaixo sao copias SQL de funcoes TypeScript do frontend
-- (`normalizeText` em lib/utils.ts, `formatCardAnswer` em lib/verdict-display.ts,
-- `isBlankAnswer` em lib/error-resolution.ts e as regras de comparacao em
-- lib/llm-error-metrics.ts). As classes de caracteres sao geradas a partir do
-- JS (`\p{Diacritic}` e `\s`), e o teste unitario both-correct-common-value
-- confere as duas contra o motor do Node; a matriz de casos de
-- supabase/tests/both_correct_common_value.test.sql e a mesma do teste
-- unitario. Divergencias conhecidas, todas fora de texto em portugues:
-- `lower` do Postgres usa o mapeamento simples de caixa (o JS usa o completo:
-- "İ" e o sigma final grego diferem), numero com zero decimal a direita e
-- chave de objeto em forma de inteiro saem em ordem ou forma diferentes no
-- texto do card.
--
-- CHECK: `error_resolution_value_iff_chosen` vira
-- `error_resolution_value_by_decision`: valor obrigatorio em "Erro do LLM" e
-- "Todos errados", opcional (e nunca JSON null) em "Ambos corretos", proibido
-- nas demais. "So quando a fonte diverge" depende de outras tabelas e fica na
-- invariante `ambos-corretos-com-valor-so-com-fonte-divergente`.

BEGIN;

-- ── Funcoes puras (copias do TypeScript) ─────────────────────────────────

-- `String.prototype.trim` do JS. btrim tira so o espaco comum.
CREATE FUNCTION public.answer_js_trim(p_text TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE STRICT SET search_path = '' AS $$
  SELECT pg_catalog.regexp_replace(p_text,
    -- classe: espaco do JS
    '^[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028-\u2029\u202F\u205F\u3000\uFEFF]+|[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028-\u2029\u202F\u205F\u3000\uFEFF]+$',
    '', 'g');
$$;

-- `normalizeText`: NFD, sem diacritico, minuscula, espaco interno unico, sem
-- espaco nas pontas. Na mesma ordem do JS.
CREATE FUNCTION public.answer_normalize_text(p_text TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE STRICT SET search_path = '' AS $$
  SELECT pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.regexp_replace(
    pg_catalog.normalize(p_text, 'NFD'),
    -- classe: diacritico do JS
    '[\u005E\u0060\u00A8\u00AF\u00B4\u00B7-\u00B8\u02B0-\u034E\u0350-\u0357\u035D-\u0362\u0374-\u0375\u037A\u0384-\u0385\u0483-\u0487\u0559\u0591-\u05A1\u05A3-\u05BD\u05BF\u05C1-\u05C2\u05C4\u064B-\u0652\u0657-\u0658\u06DF-\u06E0\u06E5-\u06E6\u06EA-\u06EC\u0730-\u074A\u07A6-\u07B0\u07EB-\u07F5\u0818-\u0819\u0898-\u089F\u08C9-\u08D2\u08E3-\u08FE\u093C\u094D\u0951-\u0954\u0971\u09BC\u09CD\u0A3C\u0A4D\u0ABC\u0ACD\u0AFD-\u0AFF\u0B3C\u0B4D\u0B55\u0BCD\u0C3C\u0C4D\u0CBC\u0CCD\u0D3B-\u0D3C\u0D4D\u0DCA\u0E3A\u0E47-\u0E4C\u0E4E\u0EBA\u0EC8-\u0ECC\u0F18-\u0F19\u0F35\u0F37\u0F39\u0F3E-\u0F3F\u0F82-\u0F84\u0F86-\u0F87\u0FC6\u1037\u1039-\u103A\u1063-\u1064\u1069-\u106D\u1087-\u108D\u108F\u109A-\u109B\u135D-\u135F\u1714-\u1715\u1734\u17C9-\u17D3\u17DD\u1939-\u193B\u1A60\u1A75-\u1A7C\u1A7F\u1AB0-\u1ABE\u1AC1-\u1ACB\u1B34\u1B44\u1B6B-\u1B73\u1BAA-\u1BAB\u1BE6\u1BF2-\u1BF3\u1C36-\u1C37\u1C78-\u1C7D\u1CD0-\u1CE8\u1CED\u1CF4\u1CF7-\u1CF9\u1D2C-\u1D6A\u1DC4-\u1DCF\u1DF5-\u1DFF\u1FBD\u1FBF-\u1FC1\u1FCD-\u1FCF\u1FDD-\u1FDF\u1FED-\u1FEF\u1FFD-\u1FFE\u2CEF-\u2CF1\u2E2F\u302A-\u302F\u3099-\u309C\u30FC\uA66F\uA67C-\uA67D\uA67F\uA69C-\uA69D\uA6F0-\uA6F1\uA700-\uA721\uA788-\uA78A\uA7F8-\uA7F9\uA806\uA82C\uA8C4\uA8E0-\uA8F1\uA92B-\uA92E\uA953\uA9B3\uA9C0\uA9E5\uAA7B-\uAA7D\uAABF-\uAAC2\uAAF6\uAB5B-\uAB5F\uAB69-\uAB6B\uABEC-\uABED\uFB1E\uFE20-\uFE2F\uFF3E\uFF40\uFF70\uFF9E-\uFF9F\uFFE3\U000102E0\U00010780-\U00010785\U00010787-\U000107B0\U000107B2-\U000107BA\U00010A38-\U00010A3A\U00010A3F\U00010AE5-\U00010AE6\U00010D22-\U00010D27\U00010D4E\U00010D69-\U00010D6D\U00010EFD-\U00010EFF\U00010F46-\U00010F50\U00010F82-\U00010F85\U00011046\U00011070\U000110B9-\U000110BA\U00011133-\U00011134\U00011173\U000111C0\U000111CA-\U000111CC\U00011235-\U00011236\U000112E9-\U000112EA\U0001133B-\U0001133C\U0001134D\U00011366-\U0001136C\U00011370-\U00011374\U000113CE-\U000113D0\U000113D2-\U000113D3\U000113E1-\U000113E2\U00011442\U00011446\U000114C2-\U000114C3\U000115BF-\U000115C0\U0001163F\U000116B6-\U000116B7\U0001172B\U00011839-\U0001183A\U0001193D-\U0001193E\U00011943\U000119E0\U00011A34\U00011A47\U00011A99\U00011C3F\U00011D42\U00011D44-\U00011D45\U00011D97\U00011F41-\U00011F42\U00011F5A\U00013447-\U00013455\U0001612F\U00016AF0-\U00016AF4\U00016B30-\U00016B36\U00016D6B-\U00016D6C\U00016F8F-\U00016F9F\U00016FF0-\U00016FF1\U0001AFF0-\U0001AFF3\U0001AFF5-\U0001AFFB\U0001AFFD-\U0001AFFE\U0001CF00-\U0001CF2D\U0001CF30-\U0001CF46\U0001D167-\U0001D169\U0001D16D-\U0001D172\U0001D17B-\U0001D182\U0001D185-\U0001D18B\U0001D1AA-\U0001D1AD\U0001E030-\U0001E06D\U0001E130-\U0001E136\U0001E2AE\U0001E2EC-\U0001E2EF\U0001E5EE-\U0001E5EF\U0001E8D0-\U0001E8D6\U0001E944-\U0001E946\U0001E948-\U0001E94A]',
    '', 'g')),
    '[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028-\u2029\u202F\u205F\u3000\uFEFF]+', ' ', 'g'), ' ');
$$;

-- `isBlankAnswer`: sem a chave (SQL NULL), JSON null, texto so de espaco ou [].
CREATE FUNCTION public.answer_is_blank(p_answer JSONB)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_answer IS NULL
    OR pg_catalog.jsonb_typeof(p_answer) = 'null'
    OR (pg_catalog.jsonb_typeof(p_answer) = 'string' AND public.answer_js_trim(p_answer #>> '{}') = '')
    OR (pg_catalog.jsonb_typeof(p_answer) = 'array' AND pg_catalog.jsonb_array_length(p_answer) = 0);
$$;

-- `normalizeForComparison`, como JSONB: texto normalizado, array com os
-- itens de texto normalizados, o resto como esta. Sem a chave fica NULL, que
-- so e igual a outro NULL pelo IS NOT DISTINCT FROM, como o `undefined` do JS
-- na chave do union-find.
CREATE FUNCTION public.answer_comparison_key(p_answer JSONB)
RETURNS JSONB
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE pg_catalog.jsonb_typeof(p_answer)
    WHEN 'string' THEN pg_catalog.to_jsonb(public.answer_normalize_text(p_answer #>> '{}'))
    WHEN 'array' THEN COALESCE((
      SELECT pg_catalog.jsonb_agg(CASE WHEN pg_catalog.jsonb_typeof(item) = 'string'
        THEN pg_catalog.to_jsonb(public.answer_normalize_text(item #>> '{}')) ELSE item END ORDER BY position)
      FROM pg_catalog.jsonb_array_elements(p_answer) WITH ORDINALITY AS element(item, position)), '[]'::JSONB)
    ELSE p_answer END;
$$;

-- Os itens de texto de uma resposta `multi`, como conjunto ordenado.
CREATE FUNCTION public.answer_string_set(p_answer JSONB)
RETURNS TEXT[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT item #>> '{}' ORDER BY item #>> '{}'), '{}')
  FROM pg_catalog.jsonb_array_elements(
    CASE WHEN pg_catalog.jsonb_typeof(p_answer) = 'array' THEN p_answer ELSE '[]'::JSONB END) AS element(item)
  WHERE pg_catalog.jsonb_typeof(item) = 'string';
$$;

-- `answersAgree` (llm-error-metrics.ts): branco so concorda com branco;
-- `multi` com dois arrays compara conjuntos; o resto, pela chave de
-- comparacao.
CREATE FUNCTION public.answers_agree(p_field JSONB, p_a JSONB, p_b JSONB)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN public.answer_is_blank(p_a) OR public.answer_is_blank(p_b)
      THEN public.answer_is_blank(p_a) AND public.answer_is_blank(p_b)
    WHEN p_field->>'type' = 'multi' AND pg_catalog.jsonb_typeof(p_a) = 'array' AND pg_catalog.jsonb_typeof(p_b) = 'array'
      THEN public.answer_string_set(p_a) = public.answer_string_set(p_b)
    ELSE public.answer_comparison_key(p_a) = public.answer_comparison_key(p_b)
  END;
$$;

-- `String(v)` do JS para os valores que o card junta: array vira os itens
-- unidos por "," (null vira vazio), objeto vira "[object Object]".
CREATE FUNCTION public.answer_js_string(p_value JSONB)
RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE pg_catalog.jsonb_typeof(p_value)
    WHEN 'string' THEN p_value #>> '{}'
    WHEN 'array' THEN COALESCE((
      SELECT pg_catalog.string_agg(CASE WHEN pg_catalog.jsonb_typeof(item) = 'null' THEN '' ELSE public.answer_js_string(item) END, ',' ORDER BY position)
      FROM pg_catalog.jsonb_array_elements(p_value) WITH ORDINALITY AS element(item, position)), '')
    WHEN 'object' THEN '[object Object]'
    WHEN 'null' THEN 'null'
    ELSE p_value #>> '{}' END;
$$;

-- `formatPartialDate`: "XX/03/2024" vira "—/03/2024".
CREATE FUNCTION public.answer_partial_date(p_text TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE STRICT SET search_path = '' AS $$
  SELECT CASE WHEN p_text ~* '^[0-9X]+/[0-9X]+/[0-9X]+$' AND p_text ~* 'X'
    THEN pg_catalog.regexp_replace(p_text, 'X+', '—', 'gi') ELSE p_text END;
$$;

-- `formatCardAnswer`: o texto que o card da Comparacao exibe e que o voto no
-- card grava como veredito.
CREATE FUNCTION public.answer_card_text(p_answer JSONB)
RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN p_answer IS NULL OR pg_catalog.jsonb_typeof(p_answer) = 'null' THEN ''
    WHEN pg_catalog.jsonb_typeof(p_answer) = 'string' THEN public.answer_partial_date(public.answer_js_trim(p_answer #>> '{}'))
    WHEN pg_catalog.jsonb_typeof(p_answer) = 'array' THEN COALESCE((
      SELECT pg_catalog.string_agg(CASE pg_catalog.jsonb_typeof(item)
          WHEN 'string' THEN public.answer_js_trim(item #>> '{}')
          WHEN 'null' THEN ''
          ELSE public.answer_js_string(item) END, ', ' ORDER BY position)
      FROM pg_catalog.jsonb_array_elements(p_answer) WITH ORDINALITY AS element(item, position)), '')
    WHEN pg_catalog.jsonb_typeof(p_answer) = 'object' THEN COALESCE((
      SELECT pg_catalog.string_agg(pair.key || ': ' || public.answer_js_string(pair.value), ', ' ORDER BY pair.position)
      FROM pg_catalog.jsonb_each(p_answer) WITH ORDINALITY AS pair(key, value, position)
      WHERE pg_catalog.jsonb_typeof(pair.value) <> 'null'
        AND public.answer_js_trim(public.answer_js_string(pair.value)) <> ''), '')
    ELSE p_answer #>> '{}' END;
$$;

-- A selecao que um veredito de `multi` marca (`verdictSelection`): o JSON
-- `{opcao: bool}` da grade, ou o texto votado em card, lido como uma opcao
-- inteira ou como partes separadas por ", ".
CREATE FUNCTION public.verdict_multi_selection(p_verdict TEXT, p_options JSONB)
RETURNS TEXT[]
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  v_text TEXT := public.answer_js_trim(COALESCE(p_verdict, ''));
  v_parsed JSONB;
BEGIN
  IF pg_catalog.left(v_text, 1) = '{' THEN
    BEGIN
      v_parsed := v_text::JSONB;
    EXCEPTION WHEN others THEN
      v_parsed := NULL;
    END;
    IF pg_catalog.jsonb_typeof(v_parsed) = 'object' THEN
      RETURN (SELECT COALESCE(pg_catalog.array_agg(DISTINCT entry.key ORDER BY entry.key), '{}')
              FROM pg_catalog.jsonb_each(v_parsed) AS entry WHERE entry.value = 'true'::JSONB);
    END IF;
  END IF;
  IF v_text = '' THEN RETURN '{}'; END IF;
  IF p_options @> pg_catalog.jsonb_build_array(v_text) THEN RETURN ARRAY[v_text]; END IF;
  RETURN (SELECT COALESCE(pg_catalog.array_agg(DISTINCT public.answer_js_trim(part) ORDER BY public.answer_js_trim(part)), '{}')
          FROM pg_catalog.regexp_split_to_table(v_text, ', ') AS part);
END;
$$;

-- `verdictMatcher` (llm-error-metrics.ts): se uma resposta crua casa com o
-- texto do veredito.
CREATE FUNCTION public.verdict_matches_answer(p_field JSONB, p_verdict TEXT, p_answer JSONB)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN p_field->>'type' = 'multi' AND pg_catalog.jsonb_typeof(p_field->'options') = 'array'
         AND pg_catalog.jsonb_array_length(p_field->'options') > 0
      THEN public.answer_string_set(p_answer) = public.verdict_multi_selection(p_verdict, p_field->'options')
    ELSE (public.answer_is_blank(p_answer) AND public.answer_js_trim(COALESCE(p_verdict, '')) = '')
      OR (pg_catalog.jsonb_typeof(p_answer) = 'string'
          AND public.answer_normalize_text(p_answer #>> '{}') = public.answer_normalize_text(p_verdict))
      OR public.answer_normalize_text(public.answer_card_text(p_answer)) = public.answer_normalize_text(p_verdict)
  END;
$$;

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

-- ── Valor comum ───────────────────────────────────────────────────────────

-- O valor que "Ambos corretos" grava sobre um contexto ja conferido por
-- `llm_error_context`, ou NULL quando nao ha (regras (1) a (4) do cabecalho).
-- Le as respostas e os pares "=" vigentes; e INVOKER e fechada para o
-- cliente: quem a chama e `set_error_resolution` e `both_correct_value`,
-- ambas DEFINER, com o contexto recalculado.
CREATE FUNCTION public.both_correct_common_value(p_context JSONB)
RETURNS JSONB
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE
  v_field JSONB := p_context->'field_definition';
  v_field_name TEXT := p_context->>'field_name';
  v_project UUID := (p_context->>'project_id')::UUID;
  v_document UUID := (p_context->>'document_id')::UUID;
  v_llm_id UUID := (p_context->>'llm_response_id')::UUID;
  v_round UUID := (p_context->>'round_id')::UUID;
  v_verdict TEXT := p_context->'source'->>'verdict';
  v_llm JSONB;
  v_value JSONB;
  v_verdict_matches BOOLEAN;
  v_humans BIGINT;
  v_disagreeing BIGINT;
BEGIN
  -- (1) So a Comparacao tem veredito que pode ficar para tras.
  IF p_context->'source'->>'kind' IS DISTINCT FROM 'comparacao' OR v_verdict IS NULL THEN RETURN NULL; END IF;
  -- (2) A arbitragem escolheu a propria resposta do LLM: o veredito e ela.
  IF p_context->'source'->>'chosen_response_id' = v_llm_id::TEXT THEN RETURN NULL; END IF;

  v_llm := CASE WHEN COALESCE((p_context->'llm_value'->>'present')::BOOLEAN, false)
    THEN p_context->'llm_value'->'value' END;
  IF public.answer_is_blank(v_llm) THEN
    -- Branco so e resposta em pergunta condicional, e so na forma canonica.
    IF NOT COALESCE(pg_catalog.jsonb_typeof(v_field->'condition') = 'object', false) THEN RETURN NULL; END IF;
    v_value := CASE WHEN v_field->>'type' = 'multi' THEN '[]'::JSONB ELSE '""'::JSONB END;
  ELSIF public.error_resolution_value_problem(v_field, v_llm) IS NULL THEN
    v_value := v_llm;
  ELSE
    -- (4) A resposta do LLM saiu do dominio atual da pergunta.
    RETURN NULL;
  END IF;

  -- A classe de equivalencia do LLM, pelo union-find da metrica
  -- (`groupKeysFor`): todas as respostas do documento, de qualquer rodada,
  -- ligadas por resposta igual depois de normalizada ou por par "=" vigente
  -- (o snapshot dos dois lados ainda e a resposta atual).
  WITH RECURSIVE document_responses AS (
    SELECT response.id, response.answers -> v_field_name AS answer,
      public.answer_comparison_key(response.answers -> v_field_name) AS answer_key
    FROM public.responses AS response
    WHERE response.project_id = v_project AND response.document_id = v_document
  ), current_pairs AS (
    SELECT pair.response_a_id AS a_id, pair.response_b_id AS b_id
    FROM public.response_equivalences AS pair
    JOIN document_responses AS a ON a.id = pair.response_a_id
    JOIN document_responses AS b ON b.id = pair.response_b_id
    WHERE pair.project_id = v_project AND pair.document_id = v_document
      AND pair.field_name = v_field_name AND pair.superseded_at IS NULL
      AND public.answer_comparison_key(COALESCE(pair.response_a_answer_snapshot, 'null'::JSONB)) = a.answer_key
      AND public.answer_comparison_key(COALESCE(pair.response_b_answer_snapshot, 'null'::JSONB)) = b.answer_key
  ), edges AS (
    SELECT a.id AS source_id, b.id AS target_id
    FROM document_responses AS a
    JOIN document_responses AS b ON a.answer_key IS NOT DISTINCT FROM b.answer_key AND a.id <> b.id
    UNION SELECT a_id, b_id FROM current_pairs
    UNION SELECT b_id, a_id FROM current_pairs
  ), llm_class AS (
    SELECT v_llm_id AS id
    UNION
    SELECT edges.target_id FROM llm_class JOIN edges ON edges.source_id = llm_class.id
  )
  SELECT
    -- (2) O veredito casa com o LLM, ou com resposta que um par liga a ele.
    EXISTS (SELECT 1 FROM llm_class JOIN document_responses AS response ON response.id = llm_class.id
            WHERE public.verdict_matches_answer(v_field, v_verdict, response.answer)),
    (SELECT pg_catalog.count(*) FROM public.responses AS human
     WHERE human.project_id = v_project AND human.document_id = v_document
       AND human.respondent_type = 'humano' AND human.is_latest
       AND human.round_id IS NOT DISTINCT FROM v_round),
    -- (3) Pesquisador corrente que nao concorda com o LLM.
    (SELECT pg_catalog.count(*) FROM public.responses AS human
     WHERE human.project_id = v_project AND human.document_id = v_document
       AND human.respondent_type = 'humano' AND human.is_latest
       AND human.round_id IS NOT DISTINCT FROM v_round
       AND NOT public.answers_agree(v_field, v_llm, human.answers -> v_field_name)
       AND human.id NOT IN (SELECT id FROM llm_class))
  INTO v_verdict_matches, v_humans, v_disagreeing;

  IF v_verdict_matches OR v_humans = 0 OR v_disagreeing > 0 THEN RETURN NULL; END IF;
  RETURN v_value;
END;
$$;

-- A previa do dialogo: o mesmo calculo, sobre o contexto recalculado. Quem nao
-- ve o contexto (fora do projeto, documento excluido) recebe NULL; contexto
-- que ja mudou e recusado como no RPC, em vez de prometer um valor velho.
CREATE FUNCTION public.both_correct_value(p_context JSONB)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_context JSONB;
BEGIN
  v_context := public.llm_error_context((p_context->>'project_id')::UUID, (p_context->>'document_id')::UUID,
    p_context->>'field_name', (p_context->>'llm_response_id')::UUID, (p_context->>'human_response_id')::UUID,
    p_context->'source'->>'kind', (p_context->'source'->>'id')::UUID);
  IF v_context IS NULL THEN RETURN NULL; END IF;
  IF v_context IS DISTINCT FROM p_context THEN
    RAISE EXCEPTION 'As respostas mudaram. Recarregue antes de confirmar.' USING ERRCODE = '40001';
  END IF;
  RETURN public.both_correct_common_value(v_context);
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

-- A de 20260924120000_error_resolutions_resposta_em_branco.sql com tres
-- pontos alterados: o valor comum de "Ambos corretos" (calculado, conferido
-- contra `p_value` e gravado), a exigencia de resposta do LLM em "Ambos
-- corretos" (dispensada quando ha branco comum de condicional) e a validacao
-- por tipo, agora em `error_resolution_value_problem`. A assinatura nao muda,
-- entao `OR REPLACE` preserva os grants.
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
  v_conditional BOOLEAN;
  v_common JSONB;
  v_problem TEXT;
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
  v_field := v_context->'field_definition';
  -- COALESCE: sem a chave, jsonb_typeof devolve NULL, e um NULL aqui faria os
  -- IF abaixo pularem o guard do LLM e a validacao por tipo inteira.
  v_conditional := COALESCE(pg_catalog.jsonb_typeof(v_field->'condition') = 'object', false);

  -- "Ambos corretos": o valor comum e calculado aqui, sobre as respostas
  -- vigentes. O cliente manda o que a previa lhe mostrou; qualquer diferenca
  -- e resposta que mudou no meio do caminho ou cliente adulterado.
  IF p_decision = 'both_correct' THEN
    v_common := public.both_correct_common_value(v_context);
    IF v_common IS DISTINCT FROM NULLIF(p_value, 'null'::JSONB) THEN
      RAISE EXCEPTION 'O valor que "Ambos corretos" grava no gabarito mudou. Recarregue antes de confirmar.' USING ERRCODE = '40001';
    END IF;
  END IF;

  IF ((p_decision = 'both_correct' AND v_common IS NULL) OR (p_decision = 'llm_correct' AND NOT v_conditional))
    AND NOT (v_context->'llm_value'->>'present')::BOOLEAN
    THEN RAISE EXCEPTION 'A resposta do LLM não contém este campo.' USING ERRCODE = '22023'; END IF;

  -- "Erro do LLM" e "Todos errados": o valor aprovado e escolhido pelo revisor nas opcoes atuais
  -- do campo. A resposta humana do contexto e so ancora de invalidacao, nao a
  -- origem do valor, por isso nao se exige mais que ela contenha o campo.
  IF p_decision IN ('researchers_correct', 'all_wrong') THEN
    v_type := v_field->>'type';
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

REVOKE ALL ON FUNCTION public.answer_js_trim(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.answer_normalize_text(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.answer_is_blank(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.answer_comparison_key(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.answer_string_set(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.answers_agree(JSONB, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.answer_js_string(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.answer_partial_date(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.answer_card_text(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.verdict_multi_selection(TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.verdict_matches_answer(JSONB, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.error_resolution_value_problem(JSONB, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.both_correct_common_value(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.both_correct_value(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.both_correct_value(JSONB) TO authenticated, service_role;

COMMIT;
