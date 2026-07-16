-- Impede que um membro plante uma resposta "do LLM" com a própria autoria.
--
-- A policy "Users manage own responses" (20260611130000:83) é FOR ALL com
-- USING mas sem WITH CHECK, e o Postgres reusa o USING no INSERT/UPDATE. O
-- predicado autoriza pelo respondent_id e nunca olha o respondent_type, então
-- um pesquisador do projeto podia gravar
-- {respondent_type:'llm', respondent_id:<próprio>} direto pelo PostgREST: o
-- braço `respondent_id IN auth_user_member_identity_ids(project_id)` aceita.
-- enforce_comparison_response_actor (20260715180000:115) não cobre — ele sai
-- em RETURN NEW quando respondent_type <> 'humano'.
--
-- Efeito do ataque: final_answers e a detecção de divergência escolhem o braço
-- LLM por respondent_type; uma "resposta do LLM" idêntica à codificação humana
-- não gera field_review, e o campo entra no dataset como consenso, sem revisão.
--
-- A correção é uma invariante de schema, não outra policy: o LLM não é uma
-- pessoa e nunca tem respondent_id. Isso fecha o vetor pelos dois lados sem
-- tocar no fluxo legítimo — o backend insere respostas LLM sem respondent_id
-- (backend/services/llm_runner.py) e saveResponse grava sempre 'humano'. Com o
-- CHECK, 'llm' + respondent_id próprio viola a constraint, e 'llm' +
-- respondent_id NULL não satisfaz o braço de identidade da policy.
BEGIN;

-- ADD CONSTRAINT valida as linhas existentes e abortaria a migration com um
-- erro genérico. O preflight nomeia o problema em vez de deixar o deploy
-- falhar sem contexto; nenhum dado é corrigido automaticamente porque uma
-- resposta LLM com autor humano é ambígua — só quem conhece o projeto decide
-- se aquilo é resposta do LLM ou codificação de alguém.
DO $$
DECLARE
  v_offenders INTEGER;
BEGIN
  SELECT pg_catalog.count(*)
  INTO v_offenders
  FROM public.responses
  WHERE respondent_type = 'llm'
    AND respondent_id IS NOT NULL;

  IF v_offenders > 0 THEN
    RAISE EXCEPTION
      'responses contém % resposta(s) llm com respondent_id — revise a autoria antes de aplicar',
      v_offenders
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER TABLE public.responses
  ADD CONSTRAINT responses_llm_has_no_human_actor_check
  CHECK (respondent_type <> 'llm' OR respondent_id IS NULL);

COMMIT;
