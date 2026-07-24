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
-- O que esta migration NÃO toca, de propósito: pydantic_code, pydantic_hash,
-- semver e schema_change_log. Respostas LLM legadas têm no pydantic_hash seu
-- único vínculo com o schema (ver 20260505000001_revive_orphan_llm_responses):
-- reescrever código/hash em massa fora de um save as tiraria da fila de
-- Comparação. O `id` só entra no código Pydantic gerado no PRÓXIMO save de
-- cada projeto, quando o hash muda de qualquer forma.

-- Parte 2: o estado ruim vira inconstruível. A função é IMMUTABLE sobre o
-- input (só funções jsonb do pg_catalog), o que a torna usável em CHECK.
-- A regex é a mesma forma canônica com hífens que o frontend valida com
-- z.uuid() e que compile_pydantic exige.
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
          OR f.value->>'id' !~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'
          OR jsonb_typeof(f.value->'name') IS DISTINCT FROM 'string'
     )
     AND (SELECT count(*) FROM jsonb_array_elements(fields)) =
         (SELECT count(DISTINCT lower(f.value->>'id'))
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
