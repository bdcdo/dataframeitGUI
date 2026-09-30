-- A condição de visibilidade de um campo passa a sair no código Pydantic gerado
-- como `json_schema_extra={"visible_if": {...}}`, e não mais `"condition"`.
--
-- Por quê: a biblioteca dataframeit usa `condition` em `json_schema_extra` com
-- outro sentido (execução condicional na busca por campo) e, desde a 0.10.0,
-- recusa o modelo que a traz sem busca por campo ligada. O GUI adotou a chave
-- depois dela, e o modelo que o `llm_runner` entrega à biblioteca carrega o
-- código armazenado. O gerador (`trailingExtras` em schema-utils.ts) passa a
-- emitir `visible_if` na mesma posição, e o compilador e o avaliador leem
-- `visible_if`, com `condition` como leitura legada (VISIBILITY_KEY em
-- backend/services/pydantic_compiler.py).
--
-- Esta migration reescreve o código armazenado agora, em vez de esperar o
-- próximo save de cada projeto. O que ela NÃO toca: `pydantic_fields` (o
-- objeto de campo continua com `condition`, que funções SQL, o Zod e o contexto
-- das decisões do LLM Insights leem), semver, `schema_change_log` e os
-- snapshots em `llm_runs.pydantic_code`, que são históricos.
--
-- O `pydantic_hash` é sha256 do texto e muda nos projetos com campo
-- condicional. Respostas LLM sem semver e respostas sem `answer_field_hashes`
-- dependem dele (ver 20260505000001_revive_orphan_llm_responses). Medido na
-- produção em 30/09/2026, só com leitura: três projetos têm condicional
-- (Zolgensma com 7 campos, Zolgensma - Judiciario com 5, PIBIC - Tráfico |
-- Parte 2 com 4). O Zolgensma tem 540 respostas LLM sem semver e 4 humanas sem
-- hash por campo, e todas já tinham hash diferente do atual (as LLM) ou nulo
-- (as humanas): já estavam fora da fila de Comparação e já apareciam como
-- desatualizadas. Os outros dois projetos não têm resposta nessas condições.
-- Sobram dois efeitos: o incremento de `schema_revision` faz a aba aberta no
-- editor de schema tratar a mudança como revisão remota, e uma reconciliação
-- de auto-revisão em curso é tentada de novo pelo compare-and-swap do hash.
--
-- ORDEM DE ROLLOUT: deploy antes, migration depois. O código novo lê as duas
-- chaves, e o antigo só conhece `condition`. Com a migration antes, no
-- intervalo o backend antigo leria o código migrado sem condição e deixaria de
-- podar os condicionais inativos, o `recover-fields` perderia a condição, e um
-- save pelo frontend antigo regravaria `condition` naquele projeto.
--
-- A atualização do backend para a dataframeit 0.10, que recusa `condition`,
-- vem depois desta migration.

BEGIN;

-- A troca é textual e precisa ser a mesma que o gerador faz: `"condition": {`
-- só aparece em `json_schema_extra`, porque o gerador escapa toda aspa de texto
-- de usuário (descrição, help_text), e a aspa de fechamento escapada
-- (`condition\":`) não casa o padrão. Medido na produção em 30/09/2026: todo
-- `condition` do código armazenado está nesse formato. Função IMMUTABLE e pura
-- para que o teste SQL exercite a regra.
CREATE OR REPLACE FUNCTION public.pydantic_code_visibility_renamed(p_code text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT pg_catalog.regexp_replace(p_code, '"condition": \{', '"visible_if": {', 'g');
$$;

-- O hash é o mesmo que commit_project_schema grava (sha256 do texto, 16 hex),
-- e o incremento de schema_revision no mesmo UPDATE satisfaz
-- enforce_project_schema_revision_trigger.
UPDATE public.projects p
SET pydantic_code = public.pydantic_code_visibility_renamed(p.pydantic_code),
    pydantic_hash = substring(
      encode(
        extensions.digest(public.pydantic_code_visibility_renamed(p.pydantic_code), 'sha256'),
        'hex'
      ) FROM 1 FOR 16
    ),
    schema_revision = p.schema_revision + 1
WHERE p.pydantic_code IS DISTINCT FROM public.pydantic_code_visibility_renamed(p.pydantic_code);

-- Todo campo com condição em pydantic_fields tem de ter saído com `visible_if`
-- no código; se algum projeto divergir, falhar aqui, com o id nomeado. Projeto
-- com pydantic_fields vazio e código gravado (o legado que recover-fields
-- atende) fica fora da conferência, porque não há com o que comparar.
DO $$
DECLARE
  v_bad RECORD;
BEGIN
  SELECT p.id,
         (SELECT count(*) FROM jsonb_array_elements(p.pydantic_fields) AS f(value)
           WHERE jsonb_typeof(f.value->'condition') = 'object') AS campos,
         (SELECT count(*) FROM regexp_matches(p.pydantic_code, '"visible_if": \{', 'g')) AS no_codigo
    INTO v_bad
    FROM public.projects p
   WHERE p.pydantic_code IS NOT NULL
     AND jsonb_array_length(p.pydantic_fields) > 0
     AND (SELECT count(*) FROM jsonb_array_elements(p.pydantic_fields) AS f(value)
           WHERE jsonb_typeof(f.value->'condition') = 'object')
         IS DISTINCT FROM
         (SELECT count(*) FROM regexp_matches(p.pydantic_code, '"visible_if": \{', 'g'))
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'projeto % tem % campo(s) com condição e % "visible_if" no código',
      v_bad.id, v_bad.campos, v_bad.no_codigo;
  END IF;
END;
$$;

COMMIT;
