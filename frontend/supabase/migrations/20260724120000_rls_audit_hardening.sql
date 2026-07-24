-- Endurecimento da superfície de RLS e de execução (issue #134).
--
-- Reconstruído sobre a main de 2026-07-24. O PR #456 original foi escrito
-- contra o modelo de identidade anterior ao #440 e não é aplicável: ele
-- redefiniria os helpers canônicos, derrubaria policies de escrita que a
-- arbitragem por ciclos usa hoje (`assign_arbitration_cycles_if_eligible` é
-- SECURITY INVOKER e passa pela RLS) e colidiria em tipo de retorno com
-- `remove_response_equivalence`. Esta migration entrega apenas o que foi
-- MEDIDO como gap real contra o catálogo vigente.
--
-- Os quatro achados, medidos em 2026-07-24 com a suíte nova
-- `supabase/tests/rls_audit.test.sql` rodando contra a main:
--   1. `handle_new_user()` é SECURITY DEFINER sem `search_path` fixado;
--   2. sete funções de trigger são executáveis por papel de cliente, isto é,
--      chamáveis como RPC pelo PostgREST;
--   3. duas RPCs de domínio são executáveis por `anon`;
--   4. `remove_answer_key(uuid,text)` sobrevive sem nenhum call site.
--
-- O cruzamento de (1) e (2) é o mais grave: `handle_new_user` aparece nas duas
-- listas, então um cliente não autenticado podia invocar uma função DEFINER de
-- `search_path` mutável.

-- ========== 1. DEFINER com search_path fixado ==========
-- `search_path` mutável numa função SECURITY DEFINER é vetor de escalação: o
-- chamador escolhe o schema onde `profiles` será resolvido e a função grava na
-- tabela dele com os privilégios do owner. O corpo já qualifica `public.`, então
-- fixar o path é inócuo para o comportamento e fecha o vetor.
--
-- O trigger em auth.users continua disparando independentemente dos grants
-- abaixo: o Postgres não consulta EXECUTE do usuário sobre a função de trigger.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email);
  RETURN NEW;
END;
$$;

-- ========== 2. Funções de trigger fora da superfície RPC ==========
-- Toda função em `public` nasce com EXECUTE para PUBLIC, e o PostgREST expõe
-- como RPC tudo que o papel da requisição pode executar. Uma função de trigger
-- chamada fora do seu trigger recebe `NEW`/`OLD` nulos ou um TG_OP inexistente
-- — na melhor hipótese erra, na pior grava com os privilégios do owner.
--
-- Revogar de PUBLIC é o que de fato fecha: revogar só de `anon` e
-- `authenticated` deixaria o grant herdado de PUBLIC intacto e
-- `has_function_privilege` continuaria verdadeiro.
--
-- Nenhuma das sete tem call site em `frontend/src` ou `backend` (medido por
-- grep em 2026-07-24); todas são acionadas exclusivamente por trigger.
REVOKE ALL ON FUNCTION public.handle_new_user()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_project_schema_revision()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_projects_column_guard()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_resolver_column_guard()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_schema_change_log_column_guard()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.recompute_exclusion_pending()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.resolve_exclusion_requests_on_exclude()
  FROM PUBLIC, anon, authenticated, service_role;

-- ========== 3. RPCs de domínio fechadas a anon e service_role ==========
-- As duas são chamadas exclusivamente pelo client de sessão
-- (`createSupabaseServer()` em `actions/documents.ts` e `actions/assignments.ts`),
-- nunca pelo admin client nem pelo backend — medido por grep em 2026-07-24.
-- Logo `authenticated` é o único papel que precisa de EXECUTE, e a autorização
-- de fato acontece dentro delas e nas policies das tabelas que tocam.
--
-- `anon` tinha EXECUTE por herança de PUBLIC. Manter isso significaria aceitar
-- que uma requisição sem sessão chegasse ao corpo da RPC e dependesse apenas do
-- que ela mesma valida — defesa em uma só camada.
REVOKE ALL ON FUNCTION public.replace_and_add_documents(uuid, uuid[], boolean, jsonb, jsonb)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.replace_and_add_documents(uuid, uuid[], boolean, jsonb, jsonb)
  TO authenticated;

REVOKE ALL ON FUNCTION public.apply_lottery_assignments(uuid, text, uuid, jsonb, boolean)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.apply_lottery_assignments(uuid, text, uuid, jsonb, boolean)
  TO authenticated;

-- ========== 4. Superfície morta ==========
-- `remove_answer_key(uuid,text)` não tem call site em `frontend/src` nem em
-- `backend` (medido em 2026-07-24). Uma RPC alcançável que ninguém chama é
-- superfície de ataque sem contrapartida — o caminho vivo de remoção de gabarito
-- passa pelas RPCs de resolução.
DROP FUNCTION IF EXISTS public.remove_answer_key(uuid, text);
