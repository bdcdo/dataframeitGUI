-- Regressão da autoidentidade na remoção de membros (issue #177).
--
-- Como rodar depois de `npx supabase start` e `npx supabase db reset`:
--   docker exec -i supabase_db_frontend psql -U postgres -d postgres \
--     -X -v ON_ERROR_STOP=1 < supabase/tests/remove_project_member_invariants.test.sql

BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('17710000-0000-0000-0000-000000000001', 'issue177-coordinator@example.test'),
  ('17710000-0000-0000-0000-000000000002', 'issue177-coordinator-alias@example.test'),
  ('17710000-0000-0000-0000-000000000004', 'issue177-creator@example.test'),
  ('17710000-0000-0000-0000-000000000005', 'issue177-creator-target@example.test'),
  ('17710000-0000-0000-0000-000000000006', 'issue177-master@example.test'),
  ('17710000-0000-0000-0000-000000000007', 'issue177-master-target@example.test'),
  ('17710000-0000-0000-0000-000000000008', 'issue177-direct-target@example.test');

INSERT INTO public.projects (id, name, created_by) VALUES
  ('17700000-0000-0000-0000-000000000001', 'Issue 177 - coordinator',
   '17710000-0000-0000-0000-000000000001'),
  ('17700000-0000-0000-0000-000000000002', 'Issue 177 - creator',
   '17710000-0000-0000-0000-000000000004'),
  ('17700000-0000-0000-0000-000000000003', 'Issue 177 - master',
   '17710000-0000-0000-0000-000000000001');

INSERT INTO public.project_members (id, project_id, user_id, role) VALUES
  ('17730000-0000-0000-0000-000000000001',
   '17700000-0000-0000-0000-000000000001',
   '17710000-0000-0000-0000-000000000001', 'coordenador'),
  ('17730000-0000-0000-0000-000000000003',
   '17700000-0000-0000-0000-000000000002',
   '17710000-0000-0000-0000-000000000004', 'pesquisador'),
  ('17730000-0000-0000-0000-000000000004',
   '17700000-0000-0000-0000-000000000002',
   '17710000-0000-0000-0000-000000000005', 'pesquisador'),
  ('17730000-0000-0000-0000-000000000005',
   '17700000-0000-0000-0000-000000000003',
   '17710000-0000-0000-0000-000000000006', 'pesquisador'),
  ('17730000-0000-0000-0000-000000000006',
   '17700000-0000-0000-0000-000000000003',
   '17710000-0000-0000-0000-000000000007', 'pesquisador'),
  ('17730000-0000-0000-0000-000000000007',
   '17700000-0000-0000-0000-000000000001',
   '17710000-0000-0000-0000-000000000008', 'pesquisador');

INSERT INTO public.master_users (user_id) VALUES
  ('17710000-0000-0000-0000-000000000002'),
  ('17710000-0000-0000-0000-000000000006');

INSERT INTO public.member_email_links (
  project_id,
  member_user_id,
  email,
  linked_user_id,
  created_by
) VALUES (
  '17700000-0000-0000-0000-000000000001',
  '17710000-0000-0000-0000-000000000001',
  'issue177-coordinator-alias@example.test',
  '17710000-0000-0000-0000-000000000002',
  '17710000-0000-0000-0000-000000000001'
);

GRANT SELECT, UPDATE, DELETE ON public.project_members TO authenticated;

-- A RPC permanece SECURITY INVOKER e a autoidentidade vive numa policy
-- restritiva aplicável também a DELETE direto.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc AS p
    WHERE p.oid = 'public.remove_project_member(uuid)'::regprocedure
      AND p.prosecdef
  ) THEN
    RAISE EXCEPTION 'FALHOU contrato: remove_project_member deve ser SECURITY INVOKER';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policy AS p
    JOIN pg_class AS c ON c.oid = p.polrelid
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'project_members'
      AND p.polname = 'Members cannot remove their own identity'
      AND p.polcmd = 'd'
      AND NOT p.polpermissive
  ) THEN
    RAISE EXCEPTION 'FALHOU contrato: auto-remoção exige policy DELETE restritiva';
  END IF;
END;
$$;

-- Coordenador direto não remove sua própria membership.
SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"17710000-0000-0000-0000-000000000001"}',
  true
);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.remove_project_member(
      '17730000-0000-0000-0000-000000000001'
    );
    RAISE EXCEPTION 'FALHOU: coordenador removeu a própria membership';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;
END;
$$;
DELETE FROM public.project_members
WHERE id = '17730000-0000-0000-0000-000000000001';
DELETE FROM public.project_members
WHERE id = '17730000-0000-0000-0000-000000000007';
RESET ROLE;

-- A conta-alias também é master nesta fixture. Assim ela tem uma rota
-- permissiva própria para o DELETE, sem depender da autorização geral de
-- aliases que pertence à issue #427, e ainda não pode remover a identidade
-- canônica que exerce.
SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"17710000-0000-0000-0000-000000000002"}',
  true
);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.remove_project_member(
      '17730000-0000-0000-0000-000000000001'
    );
    RAISE EXCEPTION 'FALHOU: alias removeu a identidade canônica';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;
END;
$$;
DELETE FROM public.project_members
WHERE id = '17730000-0000-0000-0000-000000000001';
RESET ROLE;

-- Criador e master também não podem remover a identidade própria, mas mantêm
-- a autorização para remover terceiros.
SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"17710000-0000-0000-0000-000000000004"}',
  true
);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.remove_project_member(
      '17730000-0000-0000-0000-000000000003'
    );
    RAISE EXCEPTION 'FALHOU: criador removeu a própria membership';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;
END;
$$;
DELETE FROM public.project_members
WHERE id = '17730000-0000-0000-0000-000000000003';
SELECT * FROM public.remove_project_member(
  '17730000-0000-0000-0000-000000000004'
);
RESET ROLE;

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"17710000-0000-0000-0000-000000000006"}',
  true
);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.remove_project_member(
      '17730000-0000-0000-0000-000000000005'
    );
    RAISE EXCEPTION 'FALHOU: master removeu a própria membership';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;
END;
$$;
DELETE FROM public.project_members
WHERE id = '17730000-0000-0000-0000-000000000005';
SELECT * FROM public.remove_project_member(
  '17730000-0000-0000-0000-000000000006'
);
RESET ROLE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.project_members
    WHERE id IN (
      '17730000-0000-0000-0000-000000000004',
      '17730000-0000-0000-0000-000000000006',
      '17730000-0000-0000-0000-000000000007'
    )
  ) THEN
    RAISE EXCEPTION 'FALHOU: uma remoção autorizada de terceiro não ocorreu';
  END IF;

  IF (
    SELECT count(*)
    FROM public.project_members
    WHERE id IN (
      '17730000-0000-0000-0000-000000000001',
      '17730000-0000-0000-0000-000000000003',
      '17730000-0000-0000-0000-000000000005'
    )
  ) <> 3 THEN
    RAISE EXCEPTION 'FALHOU: uma tentativa de auto-remoção alterou a membership';
  END IF;

  RAISE NOTICE 'OK: RPC e DELETE direto preservam autoidentidade e removem terceiros';
END;
$$;

ROLLBACK;
