-- Impede que uma sessão de usuário grave uma resposta atribuída ao LLM.
--
-- A policy "Users manage own responses" (20260611130000_member_email_links.sql)
-- é FOR ALL com USING mas sem WITH CHECK, e o Postgres reusa o USING no
-- INSERT/UPDATE. O predicado autoriza pelo respondent_id e nunca olha o
-- respondent_type, então um pesquisador do projeto podia gravar
-- {respondent_type:'llm', respondent_id:<próprio>} direto pelo PostgREST: o
-- braço `respondent_id IN auth_user_member_identity_ids(project_id)` aceita.
-- Efeito do ataque: final_answers e a detecção de divergência escolhem o braço
-- LLM por respondent_type; uma "resposta do LLM" idêntica à codificação humana
-- não gera field_review, e o campo entra no dataset como consenso, sem revisão.
--
-- A correção explicita dois contratos complementares. Pela RLS, toda sessão
-- JWT de usuário só pode escrever resposta humana em nome da própria identidade
-- (direta ou canônica via alias) num projeto acessível; master segue limitado a
-- resposta humana própria. Respostas LLM ficam no backend sem sessão de usuário,
-- via service role. No schema, o LLM não é uma pessoa e nunca tem respondent_id,
-- inclusive quando a escrita privilegiada ignora RLS.
BEGIN;

-- Estabiliza o conjunto validado pelo preflight até a criação da constraint.
-- SHARE ROW EXCLUSIVE bloqueia escritas concorrentes sem impedir leituras.
LOCK TABLE public.responses IN SHARE ROW EXCLUSIVE MODE;

-- Preserva integralmente o USING vigente. O WITH CHECK restringe apenas o
-- estado novo produzido por INSERT/UPDATE em sessões sujeitas a RLS.
ALTER POLICY "Users manage own responses" ON public.responses
  WITH CHECK (
    respondent_type = 'humano'
    AND respondent_id IN (
      SELECT public.auth_user_member_identity_ids(project_id)
    )
    AND (
      project_id IN (SELECT public.auth_user_accessible_project_ids())
      OR public.is_master()
    )
  );

-- ADD CONSTRAINT valida as linhas existentes e abortaria a migration com um
-- erro genérico. O preflight nomeia o problema em vez de deixar o deploy
-- falhar sem contexto; nenhum dado é corrigido automaticamente porque uma
-- resposta LLM com autor humano é ambígua — só quem conhece o projeto decide
-- se aquilo é resposta do LLM ou codificação de alguém.
DO $$
DECLARE
  v_offenders BIGINT;
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
