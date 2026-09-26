-- Funções de trigger das rodadas explícitas fechadas também para service_role.
--
-- 20260731120000_explicit_assignment_rounds.sql revogou
-- `create_initial_project_round()` e `fill_current_round_id()` só de PUBLIC,
-- anon e authenticated. A checagem de `supabase/tests/rls_audit.test.sql`
-- (origem no #601) exige que nenhuma função de trigger em `public` seja
-- executável por papel de cliente, service_role incluído, e a suíte falhava na
-- main por isso. O `LIMIT 1` da checagem mostrava só a primeira; medido no
-- banco local, com todas as migrations aplicadas, as duas eram as únicas.
--
-- Função de trigger não é RPC: chamada fora do gatilho recebe NEW e OLD nulos
-- e um TG_OP inexistente. O gatilho continua disparando sem EXECUTE do papel
-- que escreve, porque o Postgres não confere esse privilégio sobre a função
-- de trigger. Nenhum código do backend ou do frontend chama as duas como RPC.

BEGIN;

REVOKE ALL ON FUNCTION public.create_initial_project_round() FROM service_role;
REVOKE ALL ON FUNCTION public.fill_current_round_id() FROM service_role;

COMMIT;
