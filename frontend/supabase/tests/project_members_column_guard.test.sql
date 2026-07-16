-- Regressão do guard de project_members (issue #243).
--
-- Como rodar (após `npx supabase start` e `npx supabase db reset`):
--   psql "$(npx supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '\"')" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/project_members_column_guard.test.sql
--
-- O teste roda inteiro dentro de BEGIN ... ROLLBACK. Os GRANTs e fixtures não
-- sobrevivem à execução; qualquer RAISE EXCEPTION marcado como FALHOU aborta.

BEGIN;

-- O Supabase Auth aceita estes usuários mínimos e o trigger handle_new_user
-- cria os profiles referenciados por projects/project_members.
INSERT INTO auth.users (id, email) VALUES
  ('24310000-0000-0000-0000-000000000001', 'issue243-coordinator@example.test'),
  ('24310000-0000-0000-0000-000000000002', 'issue243-managed@example.test'),
  ('24310000-0000-0000-0000-000000000003', 'issue243-researcher@example.test'),
  ('24310000-0000-0000-0000-000000000004', 'issue243-master@example.test'),
  ('24310000-0000-0000-0000-000000000005', 'issue243-creator@example.test'),
  ('24310000-0000-0000-0000-000000000006', 'issue243-alias@example.test');

INSERT INTO public.clerk_user_mapping
  (clerk_user_id, supabase_user_id, access_sync_version)
SELECT id::text, id, 1
FROM auth.users
WHERE id::text LIKE '24310000-0000-0000-0000-%';

INSERT INTO public.projects (id, name, created_by) VALUES
  ('24300000-0000-0000-0000-000000000001', 'Issue 243 - guard',
   '24310000-0000-0000-0000-000000000001'),
  ('24300000-0000-0000-0000-000000000002', 'Issue 243 - bootstrap',
   '24310000-0000-0000-0000-000000000005');

INSERT INTO public.project_members (project_id, user_id, role) VALUES
  ('24300000-0000-0000-0000-000000000001',
   '24310000-0000-0000-0000-000000000001', 'coordenador'),
  ('24300000-0000-0000-0000-000000000001',
   '24310000-0000-0000-0000-000000000002', 'pesquisador'),
  ('24300000-0000-0000-0000-000000000001',
   '24310000-0000-0000-0000-000000000003', 'pesquisador'),
  ('24300000-0000-0000-0000-000000000001',
   '24310000-0000-0000-0000-000000000004', 'pesquisador');

INSERT INTO public.master_users (user_id)
VALUES ('24310000-0000-0000-0000-000000000004');

-- A conta 006 exerce, neste projeto, a identidade canônica do coordenador 001.
INSERT INTO public.member_email_links (
  project_id,
  member_user_id,
  email,
  linked_user_id,
  created_by
) VALUES (
  '24300000-0000-0000-0000-000000000001',
  '24310000-0000-0000-0000-000000000001',
  'issue243-alias@example.test',
  '24310000-0000-0000-0000-000000000006',
  '24310000-0000-0000-0000-000000000001'
);

-- O teste isola RLS/trigger de privilégios concedidos pelo PostgREST. Os GRANTs
-- são revertidos junto com a transação.
GRANT SELECT ON public.projects TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.project_members TO authenticated;
GRANT SELECT, UPDATE ON public.project_members TO service_role;

-- ----- Pesquisador comum não escala o próprio papel (RLS: zero linhas) -----
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"24310000-0000-0000-0000-000000000003","supabase_uid":"24310000-0000-0000-0000-000000000003"}',
  true
);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  affected_rows INTEGER;
BEGIN
  UPDATE public.project_members
  SET role = 'coordenador'
  WHERE project_id = '24300000-0000-0000-0000-000000000001'
    AND user_id = '24310000-0000-0000-0000-000000000003';
  GET DIAGNOSTICS affected_rows = ROW_COUNT;

  IF affected_rows <> 0 THEN
    RAISE EXCEPTION 'FALHOU: pesquisador escalou o proprio papel (rows=%)', affected_rows;
  END IF;
END;
$$;
RESET ROLE;

DO $$
BEGIN
  IF (SELECT role FROM public.project_members
      WHERE project_id = '24300000-0000-0000-0000-000000000001'
        AND user_id = '24310000-0000-0000-0000-000000000003') <> 'pesquisador'
  THEN
    RAISE EXCEPTION 'FALHOU: papel do pesquisador mudou apesar da RLS';
  END IF;
  RAISE NOTICE 'OK: pesquisador comum nao escalou o proprio papel';
END;
$$;

-- ----- Coordenador continua gerenciando outro membro -----
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"24310000-0000-0000-0000-000000000001","supabase_uid":"24310000-0000-0000-0000-000000000001"}',
  true
);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  affected_rows INTEGER;
  managed public.project_members%ROWTYPE;
BEGIN
  UPDATE public.project_members
  SET role = 'coordenador',
      can_resolve = true,
      can_arbitrate = true,
      can_compare = true
  WHERE project_id = '24300000-0000-0000-0000-000000000001'
    AND user_id = '24310000-0000-0000-0000-000000000002';
  GET DIAGNOSTICS affected_rows = ROW_COUNT;

  SELECT * INTO managed
  FROM public.project_members
  WHERE project_id = '24300000-0000-0000-0000-000000000001'
    AND user_id = '24310000-0000-0000-0000-000000000002';

  IF affected_rows <> 1
     OR managed.role <> 'coordenador'
     OR NOT managed.can_resolve
     OR NOT managed.can_arbitrate
     OR NOT managed.can_compare
  THEN
    RAISE EXCEPTION 'FALHOU: coordenador nao gerenciou outro membro';
  END IF;
  RAISE NOTICE 'OK: coordenador gerenciou papel e flags de outro membro';
END;
$$;

-- ----- Coordenador pode alternar as próprias flags can_* -----
DO $$
DECLARE
  affected_rows INTEGER;
  own_member public.project_members%ROWTYPE;
BEGIN
  UPDATE public.project_members
  SET can_resolve = true,
      can_arbitrate = true,
      can_compare = true
  WHERE project_id = '24300000-0000-0000-0000-000000000001'
    AND user_id = '24310000-0000-0000-0000-000000000001';
  GET DIAGNOSTICS affected_rows = ROW_COUNT;

  SELECT * INTO own_member
  FROM public.project_members
  WHERE project_id = '24300000-0000-0000-0000-000000000001'
    AND user_id = '24310000-0000-0000-0000-000000000001';

  IF affected_rows <> 1
     OR NOT own_member.can_resolve
     OR NOT own_member.can_arbitrate
     OR NOT own_member.can_compare
  THEN
    RAISE EXCEPTION 'FALHOU: coordenador nao alternou as proprias flags can_*';
  END IF;
  RAISE NOTICE 'OK: coordenador alternou as proprias flags can_*';
END;
$$;

-- ----- Coordenador não pode mudar o próprio papel (guard: SQLSTATE 42501) -----
DO $$
DECLARE
  blocked BOOLEAN := false;
BEGIN
  BEGIN
    UPDATE public.project_members
    SET role = 'pesquisador'
    WHERE project_id = '24300000-0000-0000-0000-000000000001'
      AND user_id = '24310000-0000-0000-0000-000000000001';
  EXCEPTION
    WHEN insufficient_privilege THEN
      blocked := true;
  END;

  IF NOT blocked THEN
    RAISE EXCEPTION 'FALHOU: guard permitiu coordenador mudar o proprio papel';
  END IF;

  IF (SELECT role FROM public.project_members
      WHERE project_id = '24300000-0000-0000-0000-000000000001'
        AND user_id = '24310000-0000-0000-0000-000000000001') <> 'coordenador'
  THEN
    RAISE EXCEPTION 'FALHOU: tentativa bloqueada alterou o papel do coordenador';
  END IF;
  RAISE NOTICE 'OK: guard bloqueou mudanca do proprio papel com SQLSTATE 42501';
END;
$$;
RESET ROLE;

-- ----- Conta-alias obedece à identidade canônica do projeto -----
-- service_role com claim não nulo isola o guard da RLS: o bypass por contexto
-- administrativo só vale quando clerk_uid() é NULL. Com JWT da conta-alias, o
-- helper canônico precisa reconhecer a linha 001 como própria.
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"24310000-0000-0000-0000-000000000006","supabase_uid":"24310000-0000-0000-0000-000000000006"}',
  true
);
SET LOCAL ROLE service_role;
DO $$
DECLARE
  affected_rows INTEGER;
  canonical_member public.project_members%ROWTYPE;
  blocked BOOLEAN := false;
BEGIN
  UPDATE public.project_members
  SET can_resolve = false,
      can_arbitrate = false,
      can_compare = false
  WHERE project_id = '24300000-0000-0000-0000-000000000001'
    AND user_id = '24310000-0000-0000-0000-000000000001';
  GET DIAGNOSTICS affected_rows = ROW_COUNT;

  SELECT * INTO canonical_member
  FROM public.project_members
  WHERE project_id = '24300000-0000-0000-0000-000000000001'
    AND user_id = '24310000-0000-0000-0000-000000000001';

  IF affected_rows <> 1
     OR canonical_member.can_resolve
     OR canonical_member.can_arbitrate
     OR canonical_member.can_compare
  THEN
    RAISE EXCEPTION 'FALHOU: conta-alias nao alternou flags da linha canonica';
  END IF;

  BEGIN
    UPDATE public.project_members
    SET role = 'pesquisador'
    WHERE project_id = '24300000-0000-0000-0000-000000000001'
      AND user_id = '24310000-0000-0000-0000-000000000001';
  EXCEPTION
    WHEN insufficient_privilege THEN
      blocked := true;
  END;

  IF NOT blocked THEN
    RAISE EXCEPTION 'FALHOU: conta-alias mudou o papel da linha canonica';
  END IF;
  RAISE NOTICE 'OK: alias alternou flags, mas nao mudou o papel da identidade canonica';
END;
$$;
RESET ROLE;

-- ----- Master pode mudar o próprio papel -----
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"24310000-0000-0000-0000-000000000004","supabase_uid":"24310000-0000-0000-0000-000000000004"}',
  true
);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  affected_rows INTEGER;
BEGIN
  UPDATE public.project_members
  SET role = 'coordenador'
  WHERE project_id = '24300000-0000-0000-0000-000000000001'
    AND user_id = '24310000-0000-0000-0000-000000000004';
  GET DIAGNOSTICS affected_rows = ROW_COUNT;

  IF affected_rows <> 1 THEN
    RAISE EXCEPTION 'FALHOU: master nao alterou o proprio papel (rows=%)', affected_rows;
  END IF;
  RAISE NOTICE 'OK: master alterou o proprio papel';
END;
$$;
RESET ROLE;

-- ----- Criador sem membership faz bootstrap criador -> coordenador -----
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"24310000-0000-0000-0000-000000000005","supabase_uid":"24310000-0000-0000-0000-000000000005"}',
  true
);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  affected_rows INTEGER;
BEGIN
  INSERT INTO public.project_members (project_id, user_id, role)
  VALUES (
    '24300000-0000-0000-0000-000000000002',
    '24310000-0000-0000-0000-000000000005',
    'coordenador'
  );
  GET DIAGNOSTICS affected_rows = ROW_COUNT;

  IF affected_rows <> 1 THEN
    RAISE EXCEPTION 'FALHOU: criador nao fez bootstrap (rows=%)', affected_rows;
  END IF;
  RAISE NOTICE 'OK: criador fez bootstrap como coordenador';
END;
$$;
RESET ROLE;

-- ----- Contexto sem clerk_uid() (service role/migration) bypassa o guard -----
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL ROLE service_role;
DO $$
DECLARE
  affected_rows INTEGER;
BEGIN
  IF public.clerk_uid() IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU: fixture esperava clerk_uid() nulo';
  END IF;

  UPDATE public.project_members
  SET role = 'pesquisador'
  WHERE project_id = '24300000-0000-0000-0000-000000000001'
    AND user_id = '24310000-0000-0000-0000-000000000001';
  GET DIAGNOSTICS affected_rows = ROW_COUNT;

  IF affected_rows <> 1 THEN
    RAISE EXCEPTION 'FALHOU: contexto sem clerk_uid() nao bypassou o guard (rows=%)', affected_rows;
  END IF;
  RAISE NOTICE 'OK: contexto sem clerk_uid() bypassou o guard';
END;
$$;
RESET ROLE;

ROLLBACK;
