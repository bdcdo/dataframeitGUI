-- #473: identidade estável por campo em projects.pydantic_fields.
--
-- `PydanticField` ganha `id` UUID obrigatório: identidade de editor, merge e
-- rascunho, separada de `name` (conteúdo editável e chave de auditoria em
-- schema_change_log — a auditoria NÃO muda de chave).
--
-- Parte 1 faz o backfill dos campos existentes; parte 2 torna o estado
-- inválido irrepresentável daqui em diante (id ausente/ inválido/duplicado e
-- nome duplicado são recusados na escrita).
--
-- ORDEM DE ROLLOUT — esta migration vai ANTES do deploy do frontend.
-- Medido no remoto em 24/09/2026: dos 10 projetos, 3 têm pydantic_fields vazio,
-- 7 precisam de backfill (Zolgensma-Judiciário 31 campos, Zolgensma 28,
-- PIBIC-Tráfico Parte 2 9, PIBIC-Tráfico 1 e as 3 fixtures E2E com 6, 2 e 2) e
-- NENHUM tem nome duplicado — a constraint entra limpa. As 366 decisões com
-- contexto em error_resolutions estão nos dois projetos Zolgensma (parte 1b).
--
-- Há janela nas duas ordens, porque o contrato Zod do frontend é
-- `strictObject`: o build anterior recusa campo COM `id`, e o novo recusa campo
-- SEM `id`. Entre esta migration e o fim do deploy (ou o inverso), o editor de
-- schema (`/config/schema`) recusa abrir, toda ESCRITA de schema falha em
-- `loadSchemaSaveContext` (edição, `toggleLlmField`, aprovação de sugestão) e,
-- no LLM Insights, "Erro do LLM" e "Todos errados" mostram "A definição desta
-- pergunta não pôde ser lida". As duas falham fechadas, e codificação,
-- comparação, arbitragem, exportação e as rodadas de LLM seguem funcionando
-- (leem por cast e nunca tocam `field.id`; o `llm_runner` reconstrói o modelo
-- por `build_model_from_code`, que não valida identidade — há teste fixando
-- isso). Nada renderiza com `key={undefined}`. Por isso migration, merge e
-- deploy vão em sequência imediata: a janela dura o deploy.
--
-- O que esta migration NÃO toca, de propósito: pydantic_code, pydantic_hash,
-- semver e schema_change_log. Respostas LLM legadas têm no pydantic_hash seu
-- único vínculo com o schema (ver 20260505000001_revive_orphan_llm_responses):
-- reescrever código/hash em massa fora de um save as tiraria da fila de
-- Comparação. O `id` só entra no código Pydantic gerado no PRÓXIMO save de
-- cada projeto, quando o hash muda de qualquer forma.

-- Parte 2: o estado ruim vira inconstruível. A função é IMMUTABLE sobre o
-- input (só funções jsonb do pg_catalog), o que a torna usável em CHECK.
-- A regex é a mesma forma canônica de FIELD_ID_PATTERN no frontend
-- (pydantic-field.ts) e de `_parse_field_id` no compile_pydantic: hífens e MINÚSCULAS, casadas com `~` (não `~*`).
-- A caixa entra na constraint porque as fronteiras não desempatam igual — o
-- merge no frontend compara id por string exata, então aceitar as duas caixas
-- aqui deixaria o mesmo UUID valer como UM campo para o banco e DOIS para o
-- editor. Pelo mesmo motivo a contagem de distintos abaixo não usa lower():
-- normalizar na desduplicação seria admitir a divergência que a regex acabou
-- de tornar irrepresentável.
CREATE OR REPLACE FUNCTION public.pydantic_fields_shape_valid(fields jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT jsonb_typeof(fields) = 'array'
     AND NOT EXISTS (
       SELECT 1
       FROM jsonb_array_elements(fields) AS f(value)
       WHERE jsonb_typeof(f.value) <> 'object'
          OR jsonb_typeof(f.value->'id') IS DISTINCT FROM 'string'
          OR f.value->>'id' !~ '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'
          OR jsonb_typeof(f.value->'name') IS DISTINCT FROM 'string'
     )
     AND (SELECT count(*) FROM jsonb_array_elements(fields)) =
         (SELECT count(DISTINCT f.value->>'id')
          FROM jsonb_array_elements(fields) AS f(value))
     AND (SELECT count(*) FROM jsonb_array_elements(fields)) =
         (SELECT count(DISTINCT f.value->>'name')
          FROM jsonb_array_elements(fields) AS f(value));
$$;

-- Parte 1: backfill. Preserva ordem e todas as propriedades; atribui
-- gen_random_uuid() só a elemento sem `id`. O incremento de schema_revision no
-- mesmo UPDATE satisfaz enforce_project_schema_revision_trigger (mudança de
-- schema exige exatamente +1) e faz as abas abertas tratarem o backfill como
-- qualquer revisão remota nova.
UPDATE public.projects p
SET pydantic_fields = (
      SELECT COALESCE(
               jsonb_agg(
                 CASE
                   WHEN elem ? 'id' THEN elem
                   ELSE elem || jsonb_build_object('id', gen_random_uuid()::text)
                 END
                 ORDER BY ord
               ),
               '[]'::jsonb
             )
      FROM jsonb_array_elements(p.pydantic_fields) WITH ORDINALITY AS t(elem, ord)
    ),
    schema_revision = p.schema_revision + 1
WHERE EXISTS (
  SELECT 1
  FROM jsonb_array_elements(p.pydantic_fields) AS e(value)
  WHERE NOT (e.value ? 'id')
);

-- Parte 1b: as decisões do LLM Insights (error_resolutions) guardam em
-- context.field_definition a definição do campo que llm_error_context leu, e
-- só valem enquanto o contexto recalculado for idêntico ao guardado
-- (contextIsCurrent em frontend/src/lib/error-resolution.ts, e o
-- `IS DISTINCT FROM` de set_error_resolution). O backfill acima acrescenta
-- `id` à definição viva; sem o mesmo `id` na guardada, toda decisão existente
-- viraria "stale" e voltaria para a fila. O casamento é pelo nome, o mesmo
-- critério de llm_error_context. Só o `id` entra: definição guardada que já
-- divergia da viva em conteúdo continua divergindo, e a decisão stale segue
-- stale.
UPDATE public.error_resolutions er
SET context = jsonb_set(er.context, '{field_definition,id}', f.value->'id')
FROM public.projects p,
     jsonb_array_elements(p.pydantic_fields) AS f(value)
WHERE p.id = er.project_id
  AND f.value->>'name' = er.field_name
  AND jsonb_typeof(er.context->'field_definition') = 'object'
  AND NOT (er.context->'field_definition' ? 'id');

-- Preflight da constraint: se algum projeto já viola o shape (nome duplicado é
-- o único caso que o backfill não conserta), falhar AQUI com os ids nomeados é
-- mais diagnosticável do que o erro genérico do ALTER TABLE abaixo.
DO $$
DECLARE
  v_offenders uuid[];
BEGIN
  SELECT array_agg(p.id) INTO v_offenders
  FROM public.projects p
  WHERE NOT public.pydantic_fields_shape_valid(p.pydantic_fields);
  IF v_offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'projects com pydantic_fields inválido após o backfill: %', v_offenders;
  END IF;
END;
$$;

ALTER TABLE public.projects
  ADD CONSTRAINT projects_pydantic_fields_shape
  CHECK (public.pydantic_fields_shape_valid(pydantic_fields));
