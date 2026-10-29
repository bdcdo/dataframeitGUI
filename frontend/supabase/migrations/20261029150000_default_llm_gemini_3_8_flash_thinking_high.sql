-- projects.llm_model: default passa a ser gemini-3.8-flash. projects.llm_kwargs:
-- o default deixa de fixar temperatura, sobe o raciocinio para high e liga
-- include_justifications, que a tela (`!!`) e o backend (`pop(..., False)`)
-- leem como desligado quando a chave falta.
--
-- Motivacao: toda run saia com temperature 1.0, thinking_level medium e sem
-- justificativas sem nenhum coordenador ter escolhido isso, porque o default
-- da coluna, o fallback da pagina de configuracao e
-- `buildKwargsForCapabilities` injetavam os valores. Sem a chave
-- `temperature`, o provider aplica o default dele.
--
-- Censo antes desta migration (2026-10-29, 15 projetos, todos google_genai):
--   15x gemini-3.7-flash, temperature 1 e thinking_level medium
--    3x desses com include_justifications true (preservado abaixo)
-- Ninguem tinha saido do default, entao quem esta nele segue o default novo,
-- como fez a 20260813120000 ao trocar gemini-3-flash por gemini-3.7-flash.
--
-- Os dois valores tem de acompanhar frontend/src/lib/model-registry.ts
-- (`defaultModelForProvider("google_genai")` e
-- `buildKwargsForCapabilities({}, ...)`): o SQL nao deriva do TypeScript, e o
-- teste do registry le estas declaracoes para amarrar os dois lados.
--
-- Respostas ja gravadas nao sao tocadas: `responses.respondent_name` guarda o
-- modelo historico de cada run.

ALTER TABLE public.projects
  ALTER COLUMN llm_model SET DEFAULT 'gemini-3.8-flash';

ALTER TABLE public.projects
  ALTER COLUMN llm_kwargs
  SET DEFAULT '{"thinking_level": "high", "include_justifications": true}'::jsonb;

-- Escopo: projeto google_genai que esta exatamente no default antigo
-- (gemini-3.7-flash, temperatura 1 ou ausente, raciocinio medium ou ausente).
-- Quem escolheu outro modelo, outra temperatura ou outro nivel nao e tocado.
-- `- 'temperature'` remove a chave; `||` sobrescreve so thinking_level e
-- preserva o resto (parallel_requests, thresholds). include_justifications
-- so entra onde a chave falta: `false` explicito e escolha e fica.
UPDATE public.projects
   SET llm_model = 'gemini-3.8-flash',
       llm_kwargs = (coalesce(llm_kwargs, '{}'::jsonb) - 'temperature')
                    || '{"thinking_level": "high"}'::jsonb
                    || CASE WHEN coalesce(llm_kwargs, '{}'::jsonb) ? 'include_justifications'
                            THEN '{}'::jsonb
                            ELSE '{"include_justifications": true}'::jsonb
                       END
 WHERE llm_provider = 'google_genai'
   AND llm_model = 'gemini-3.7-flash'
   AND coalesce(llm_kwargs->>'thinking_level', 'medium') = 'medium'
   AND (
         llm_kwargs->'temperature' IS NULL
         OR (llm_kwargs->>'temperature')::numeric = 1
       );
