-- reviews.field_hash: o veredito vale enquanto a pergunta nao muda (#758).
--
-- Os leitores de `reviews` decidiam de formas diferentes se um veredito ainda
-- valia, e nenhum conferia se a pergunta tinha mudado depois da arbitragem.
-- Gabarito, export e a metrica do LLM Insights descartavam todo veredito de
-- rodada anterior (#734), mesmo com a pergunta identica; Comparacao, fecho do
-- parecer, Meus vereditos e Comentarios aceitavam veredito de qualquer rodada
-- e de qualquer versao da pergunta.
--
-- Regra unica: um review vale como gabarito sse
--   (1) o campo existe no schema atual do projeto;
--   (2) `field_hash` e o hash atual do campo, ou `field_hash` e NULL (legado,
--       sem como provar a pergunta) e
--   (3) o valor do veredito esta no dominio atual do campo, conferido so
--       quando `field_hash` e NULL ou o veredito foi copiado de uma resposta
--       (`chosen_response_id` preenchido, o voto em card).
-- O veredito digitado pelo revisor ("Nenhuma correta", sem resposta escolhida)
-- com o hash atual vale mesmo fora das opcoes: as opcoes entram no hash, entao
-- o hash igual prova que o texto foi digitado sob as opcoes atuais. Medido em
-- 2026-09-25 em producao, antes desta regra: 14 vereditos digitados com o hash
-- atual cairiam como fora do dominio, e todo veredito digitado novo em campo
-- `single` nasceria invalido (a celula nunca fecharia). O copiado fora das
-- opcoes e resposta recodificada sob outra versao da pergunta, que o backfill
-- (a) abaixo pode ter carimbado com o hash novo; esse continua invalido.
-- A rodada nao entra na regra, e editar a resposta escolhida depois da
-- arbitragem nao invalida o veredito. O hash e o `_field_hash` de
-- `computeFieldHash` (nome, tipo, opcoes e descricao), que o schema grava em
-- `pydantic_fields[].hash`.
--
-- A copia TypeScript da regra e `frontend/src/lib/review-validity.ts`; os
-- casos do teste unitario de la e da matriz de
-- `supabase/tests/reviews_field_hash.test.sql` sao os mesmos, para que as duas
-- copias falhem juntas quando uma derivar.
--
-- Dominio (3), por tipo do campo:
--   * `ambiguo`, `pular` e o veredito em branco valem sempre. O branco e o
--     voto no grupo de respostas vazias, que diz "o documento nao traz o dado";
--     ele nao depende das opcoes.
--   * `single` com opcoes e sem `allow_other`: o texto sem espaco nas pontas e
--     uma das opcoes (tambem sem espaco nas pontas, porque opcao de formulario
--     carrega espaco final e o valor gravado nem sempre).
--   * `multi` com opcoes e sem `allow_other`: o JSON `{opcao: bool}` so marca
--     `true` opcoes atuais. O `multi` votado em card grava o texto "A, B"; ele
--     vale se o texto inteiro e uma opcao ou se cada parte separada por ", " e
--     uma opcao. Opcao que contem ", " num veredito em texto e hash NULL cai
--     como fora do dominio: e o unico falso negativo conhecido, e so alcanca
--     veredito legado de campo que virou `multi`.
--   * campo com `allow_other`, campo sem opcoes, texto, data e subcampos: sempre
--     no dominio.
--
-- Carimbo: gatilho BEFORE INSERT OR UPDATE OF verdict, chosen_response_id grava
-- em `field_hash` o hash do campo `field_name` no schema do projeto, ou NULL se
-- o campo nao existe ou nao tem hash. `UPDATE OF` dispara pela coluna no SET,
-- mude ou nao o valor, e o upsert de `submitVerdict` sempre poe as colunas do
-- payload no SET: toda rearbitragem recarimba, inclusive a de payload
-- identico, que e a licao de 20260918123000. Comentario, resolucao e
-- `reviewer_id` ficam fora da lista e nao recarimbam: resolver o comentario de
-- um veredito sobre a pergunta antiga nao pode revalida-lo.
--
-- `field_hash` e imutavel para o cliente no UPDATE, como `round_id` (23514). Sem
-- isso a policy `Reviewers manage reviews` deixaria um PATCH gravar o hash atual
-- num veredito dado sobre outra pergunta e ressuscita-lo sem rearbitragem. Os
-- gatilhos BEFORE do mesmo evento disparam em ordem alfabetica de nome:
-- `reviews_field_hash_immutable` ve o payload do cliente antes de
-- `reviews_stamp_field_hash` carimbar. No INSERT o valor do cliente e
-- simplesmente sobrescrito.
--
-- Backfill (`review_inferred_field_hash`), do mais confiavel ao menos:
--   (a) o hash do campo em `answer_field_hashes` da resposta escolhida;
--   (b) senao, o hash em que concordam TODAS as respostas do
--       `response_snapshot` que ainda existem (nenhuma sem hash, um hash so);
--   (c) senao, NULL.
-- Limite conhecido de (a): a resposta escolhida pode ter sido recodificada sob
-- a pergunta nova depois da arbitragem, e ai o backfill carimba o hash novo num
-- veredito dado sobre a pergunta antiga. `answer_field_hashes` e o unico
-- registro por campo que existe; o snapshot so guarda o texto das respostas.
-- A funcao fica no banco (revogada dos clientes) para o teste SQL exercitar a
-- regra, ja que os testes rodam depois das migrations e nao veem linha legada.

BEGIN;

ALTER TABLE public.reviews
  ADD COLUMN field_hash text;

-- (3) Dominio. Pura e IMMUTABLE: testavel com um JSON por caso.
CREATE FUNCTION public.review_verdict_in_domain(p_verdict text, p_field jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_text text := pg_catalog.btrim(COALESCE(p_verdict, ''));
  v_type text := p_field->>'type';
  v_options text[];
  v_parsed jsonb;
BEGIN
  IF p_field IS NULL OR pg_catalog.jsonb_typeof(p_field) IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;
  IF v_text IN ('ambiguo', 'pular', '') THEN
    RETURN true;
  END IF;
  IF COALESCE((p_field->>'allow_other')::boolean, false) THEN
    RETURN true;
  END IF;

  SELECT COALESCE(pg_catalog.array_agg(pg_catalog.btrim(option_text)), '{}')
  INTO v_options
  FROM pg_catalog.jsonb_array_elements_text(
    CASE WHEN pg_catalog.jsonb_typeof(p_field->'options') = 'array'
      THEN p_field->'options' ELSE '[]'::jsonb END
  ) AS option_text;
  IF pg_catalog.cardinality(v_options) = 0 THEN
    RETURN true;
  END IF;

  IF v_type = 'single' THEN
    RETURN v_text = ANY (v_options);
  END IF;

  IF v_type = 'multi' THEN
    IF pg_catalog.left(v_text, 1) = '{' THEN
      BEGIN
        v_parsed := v_text::jsonb;
      EXCEPTION WHEN others THEN
        v_parsed := NULL;
      END;
      IF pg_catalog.jsonb_typeof(v_parsed) = 'object' THEN
        RETURN NOT EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_each(v_parsed) AS entry
          WHERE entry.value = 'true'::jsonb
            AND NOT (pg_catalog.btrim(entry.key) = ANY (v_options))
        );
      END IF;
    END IF;
    RETURN v_text = ANY (v_options)
      OR NOT EXISTS (
        SELECT 1
        FROM pg_catalog.regexp_split_to_table(v_text, ', ') AS part
        WHERE NOT (pg_catalog.btrim(part) = ANY (v_options))
      );
  END IF;

  RETURN true;
END;
$$;

-- (1) + (2) + (3) sobre a definicao do campo ja resolvida. `p_copied` e
-- `chosen_response_id IS NOT NULL`: o dominio so e conferido no veredito sem
-- hash ou copiado de uma resposta.
CREATE FUNCTION public.review_verdict_valid(p_verdict text, p_field_hash text, p_copied boolean, p_field jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT COALESCE(
    pg_catalog.jsonb_typeof(p_field) = 'object'
      AND (p_field_hash IS NULL OR p_field_hash = p_field->>'hash')
      AND ((p_field_hash IS NOT NULL AND NOT p_copied)
           OR public.review_verdict_in_domain(p_verdict, p_field)),
    false);
$$;

-- A regra sobre uma review por id, contra o schema atual do projeto. Review
-- inexistente nao e valida.
CREATE FUNCTION public.review_is_valid(p_review_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE((
    SELECT public.review_verdict_valid(
      review.verdict,
      review.field_hash,
      review.chosen_response_id IS NOT NULL,
      (SELECT field.value
       FROM pg_catalog.jsonb_array_elements(project.pydantic_fields) AS field(value)
       WHERE field.value->>'name' = review.field_name
       LIMIT 1))
    FROM public.reviews AS review
    JOIN public.projects AS project ON project.id = review.project_id
    WHERE review.id = p_review_id
  ), false);
$$;

CREATE FUNCTION public.review_inferred_field_hash(p_review_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT COALESCE(
    (SELECT chosen.answer_field_hashes->>review.field_name
     FROM public.reviews AS review
     JOIN public.responses AS chosen ON chosen.id = review.chosen_response_id
     WHERE review.id = p_review_id),
    (SELECT pg_catalog.min(snapshot_response.answer_field_hashes->>review.field_name)
     FROM public.reviews AS review
     CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
       CASE WHEN pg_catalog.jsonb_typeof(review.response_snapshot) = 'array'
         THEN review.response_snapshot ELSE '[]'::jsonb END
     ) AS entry(value)
     JOIN public.responses AS snapshot_response
       ON snapshot_response.id::text = entry.value->>'id'
     WHERE review.id = p_review_id
     GROUP BY review.id
     HAVING pg_catalog.count(*) > 0
        AND pg_catalog.count(snapshot_response.answer_field_hashes->>review.field_name) = pg_catalog.count(*)
        AND pg_catalog.count(DISTINCT snapshot_response.answer_field_hashes->>review.field_name) = 1)
  );
$$;

REVOKE ALL ON FUNCTION public.review_verdict_in_domain(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.review_verdict_valid(text, text, boolean, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.review_inferred_field_hash(uuid) FROM PUBLIC, anon, authenticated;
-- `review_is_valid` e DEFINER e le qualquer review por id: fechada para os
-- clientes, aberta ao service_role para `npm run invariants`.
REVOKE ALL ON FUNCTION public.review_is_valid(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_is_valid(uuid) TO service_role;

-- Backfill, antes dos gatilhos: o de imutabilidade recusaria este UPDATE.
UPDATE public.reviews
SET field_hash = public.review_inferred_field_hash(id);

DO $$
DECLARE
  v_total bigint;
  v_stamped bigint;
BEGIN
  SELECT pg_catalog.count(*), pg_catalog.count(field_hash) INTO v_total, v_stamped FROM public.reviews;
  RAISE NOTICE 'reviews field_hash: % de % reviews carimbadas pelo backfill; o resto fica NULL (legado)',
    v_stamped, v_total;
END $$;

CREATE FUNCTION public.stamp_review_field_hash()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Sem linha (campo fora do schema, schema vazio), o SELECT INTO grava NULL.
  SELECT field.value->>'hash' INTO NEW.field_hash
  FROM public.projects AS project,
       pg_catalog.jsonb_array_elements(project.pydantic_fields) AS field(value)
  WHERE project.id = NEW.project_id
    AND field.value->>'name' = NEW.field_name
  LIMIT 1;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.enforce_review_field_hash_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.field_hash IS DISTINCT FROM OLD.field_hash THEN
    RAISE EXCEPTION 'reviews.field_hash e carimbada pelo servidor e nao pode ser alterada pelo cliente'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Funcao de trigger nao e RPC (20260724120000, `rls_audit.test.sql`).
REVOKE ALL ON FUNCTION public.stamp_review_field_hash()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_review_field_hash_immutable()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER reviews_field_hash_immutable
BEFORE UPDATE ON public.reviews
FOR EACH ROW EXECUTE FUNCTION public.enforce_review_field_hash_immutable();

CREATE TRIGGER reviews_stamp_field_hash
BEFORE INSERT OR UPDATE OF verdict, chosen_response_id ON public.reviews
FOR EACH ROW EXECUTE FUNCTION public.stamp_review_field_hash();

COMMIT;
