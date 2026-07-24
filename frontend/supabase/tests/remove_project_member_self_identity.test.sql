-- Contrato da remoção de membros (issue #177).
--
-- Como rodar:
--   npm run test:db:remove-member
--
-- O runner conecta como `postgres`, que é OWNER das tabelas e portanto BYPASSA
-- RLS. Todo bloco que exercita a policy troca para o role `authenticated` com
-- um JWT forjado — sem isso o teste passaria por engano, medindo o owner em vez
-- da policy.

BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('17710000-0000-0000-0000-000000000001', 'issue177-coordinator@example.test'),
  ('17710000-0000-0000-0000-000000000002', 'issue177-alias@example.test'),
  ('17710000-0000-0000-0000-000000000003', 'issue177-target@example.test'),
  ('17710000-0000-0000-0000-000000000004', 'issue177-creator@example.test'),
  ('17710000-0000-0000-0000-000000000005', 'issue177-creator-target@example.test'),
  ('17710000-0000-0000-0000-000000000006', 'issue177-master@example.test');

-- clerk_uid() resolve pelo par (sub, supabase_uid) em clerk_user_mapping: sem
-- esta linha o helper devolve NULL e todo bloco abaixo mediria "sem identidade"
-- em vez da regra sob teste.
INSERT INTO public.clerk_user_mapping
  (clerk_user_id, supabase_user_id, access_sync_version)
SELECT id::text, id, 1
FROM auth.users
WHERE id::text LIKE '17710000-0000-0000-0000-%';

INSERT INTO public.projects (id, name, created_by) VALUES
  ('17700000-0000-0000-0000-000000000001', 'Issue 177 - coordenador',
   '17710000-0000-0000-0000-000000000001'),
  ('17700000-0000-0000-0000-000000000002', 'Issue 177 - criador',
   '17710000-0000-0000-0000-000000000004');

INSERT INTO public.project_members (id, project_id, user_id, role) VALUES
  ('17730000-0000-0000-0000-000000000001',
   '17700000-0000-0000-0000-000000000001',
   '17710000-0000-0000-0000-000000000001', 'coordenador'),
  ('17730000-0000-0000-0000-000000000003',
   '17700000-0000-0000-0000-000000000001',
   '17710000-0000-0000-0000-000000000003', 'pesquisador'),
  ('17730000-0000-0000-0000-000000000004',
   '17700000-0000-0000-0000-000000000002',
   '17710000-0000-0000-0000-000000000004', 'coordenador'),
  ('17730000-0000-0000-0000-000000000005',
   '17700000-0000-0000-0000-000000000002',
   '17710000-0000-0000-0000-000000000005', 'pesquisador'),
  ('17730000-0000-0000-0000-000000000006',
   '17700000-0000-0000-0000-000000000001',
   '17710000-0000-0000-0000-000000000006', 'coordenador');

-- Master é isento da proibição, como já é do guard de mudança do próprio papel
-- (enforce_project_members_column_guard). Precisa ser MEMBRO para o caso ter
-- conteúdo: um master de fora do projeto nunca casaria o predicado.
INSERT INTO public.master_users (user_id) VALUES
  ('17710000-0000-0000-0000-000000000006');

-- A conta-alias exerce a identidade canônica do coordenador.
INSERT INTO public.member_email_links (
  project_id, member_user_id, email, linked_user_id, created_by
) VALUES (
  '17700000-0000-0000-0000-000000000001',
  '17710000-0000-0000-0000-000000000001',
  'issue177-alias@example.test',
  '17710000-0000-0000-0000-000000000002',
  '17710000-0000-0000-0000-000000000001'
);

INSERT INTO public.documents (id, project_id, external_id, title, text) VALUES
  ('17740000-0000-0000-0000-000000000001',
   '17700000-0000-0000-0000-000000000001', '177-D1', 'Doc 1', 'texto'),
  ('17740000-0000-0000-0000-000000000002',
   '17700000-0000-0000-0000-000000000001', '177-D2', 'Doc 2', 'texto'),
  ('17740000-0000-0000-0000-000000000003',
   '17700000-0000-0000-0000-000000000002', '177-D3', 'Doc 3', 'texto');

-- Do alvo: uma pendência (deve sumir) e um histórico concluído (deve ficar).
INSERT INTO public.assignments (id, project_id, document_id, user_id, status, type) VALUES
  ('17750000-0000-0000-0000-000000000001',
   '17700000-0000-0000-0000-000000000001',
   '17740000-0000-0000-0000-000000000001',
   '17710000-0000-0000-0000-000000000003', 'pendente', 'codificacao'),
  ('17750000-0000-0000-0000-000000000002',
   '17700000-0000-0000-0000-000000000001',
   '17740000-0000-0000-0000-000000000002',
   '17710000-0000-0000-0000-000000000003', 'concluido', 'codificacao'),
  ('17750000-0000-0000-0000-000000000003',
   '17700000-0000-0000-0000-000000000002',
   '17740000-0000-0000-0000-000000000003',
   '17710000-0000-0000-0000-000000000005', 'pendente', 'codificacao'),
  -- Pendência gravada sob o uid CRU da conta-alias (legado anterior à
  -- 20260716155000, quando as filas já resolviam a identidade canônica mas
  -- nem toda escrita resolvia). Não há membership com esse user_id, então ela
  -- é o caso que separa "varrer o que é do removido" de "varrer tudo que não
  -- tem membership": tem de sobreviver à remoção de qualquer outro membro.
  ('17750000-0000-0000-0000-000000000004',
   '17700000-0000-0000-0000-000000000001',
   '17740000-0000-0000-0000-000000000001',
   '17710000-0000-0000-0000-000000000002', 'pendente', 'codificacao');

GRANT SELECT, UPDATE, DELETE ON public.project_members TO authenticated;

-- ----- Contrato declarado no catálogo -----
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc AS p
    WHERE p.oid = 'public.remove_project_member(uuid)'::regprocedure
      AND p.prosecdef
  ) THEN
    RAISE EXCEPTION 'FALHOU contrato: remove_project_member deve ser SECURITY INVOKER';
  END IF;

  -- SECURITY DEFINER + service_role bypassaria a RLS e zeraria clerk_uid().
  IF NOT has_function_privilege('authenticated',
        'public.remove_project_member(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FALHOU contrato: authenticated perdeu EXECUTE na RPC';
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
      -- polroles = {0} é PUBLIC, isto é, a policy foi criada SEM cláusula TO.
      -- Numa RESTRICTIVE isso não é detalhe: com TO explícito ela só restringe
      -- os roles listados, e um role novo — ou um caminho que autentique por
      -- outro role — entraria livre justamente onde a restritiva deveria valer
      -- sempre. `service_role` continua passando por BYPASSRLS.
      AND p.polroles = '{0}'::oid[]
  ) THEN
    RAISE EXCEPTION
      'FALHOU contrato: policy DELETE deve ser restritiva e sem cláusula TO';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.project_members'::regclass
      AND tgname = 'release_pending_assignments_on_member_delete_trigger'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'FALHOU contrato: trigger de liberação de pendências ausente';
  END IF;

  RAISE NOTICE 'OK contrato: RPC INVOKER + policy restritiva + trigger presentes';
END;
$$;

-- ----- Coordenador não remove a própria membership (RPC nem DELETE direto) ---
SELECT set_config('request.jwt.claims',
  '{"sub":"17710000-0000-0000-0000-000000000001","supabase_uid":"17710000-0000-0000-0000-000000000001"}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.remove_project_member(
      '17730000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'FALHOU: coordenador removeu a própria membership pela RPC';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;
DELETE FROM public.project_members
WHERE id = '17730000-0000-0000-0000-000000000001';

-- Terceiro continua removível — e é a RPC quem devolve o projeto.
SELECT * FROM public.remove_project_member(
  '17730000-0000-0000-0000-000000000003');
RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.project_members
    WHERE id = '17730000-0000-0000-0000-000000000001'
  ) THEN
    RAISE EXCEPTION 'FALHOU: DELETE direto removeu a própria membership';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.project_members
    WHERE id = '17730000-0000-0000-0000-000000000003'
  ) THEN
    RAISE EXCEPTION 'FALHOU: remoção autorizada de terceiro não ocorreu';
  END IF;

  -- A pendência do removido volta ao pool; o histórico permanece.
  IF EXISTS (
    SELECT 1 FROM public.assignments
    WHERE id = '17750000-0000-0000-0000-000000000001'
  ) THEN
    RAISE EXCEPTION 'FALHOU: pendência do ex-membro sobreviveu à remoção';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.assignments
    WHERE id = '17750000-0000-0000-0000-000000000002' AND status = 'concluido'
  ) THEN
    RAISE EXCEPTION 'FALHOU: histórico concluído foi apagado com a membership';
  END IF;

  -- O trigger varre por (project_id, user_id) DA LINHA REMOVIDA, não "toda
  -- pendência sem membership": a do uid cru da conta-alias fica de pé, embora
  -- não tenha membership própria. Trocar o filtro por uma varredura ampla
  -- apagaria trabalho de quem continua no projeto.
  IF NOT EXISTS (
    SELECT 1 FROM public.assignments
    WHERE id = '17750000-0000-0000-0000-000000000004' AND status = 'pendente'
  ) THEN
    RAISE EXCEPTION
      'FALHOU: pendência de conta-alias caiu junto com a remoção de outro membro';
  END IF;

  -- A FK composta cuida dos aliases do membro removido; o do coordenador fica.
  IF NOT EXISTS (
    SELECT 1 FROM public.member_email_links
    WHERE member_user_id = '17710000-0000-0000-0000-000000000001'
  ) THEN
    RAISE EXCEPTION 'FALHOU: alias do coordenador sumiu sem remoção';
  END IF;

  RAISE NOTICE 'OK: autoidentidade preservada, terceiro removido, pendência liberada';
END;
$$;

-- ----- A conta-alias também não remove a identidade que exerce -----
SELECT set_config('request.jwt.claims',
  '{"sub":"17710000-0000-0000-0000-000000000002","supabase_uid":"17710000-0000-0000-0000-000000000002"}', true);
SET LOCAL ROLE authenticated;
DELETE FROM public.project_members
WHERE id = '17730000-0000-0000-0000-000000000001';
RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.project_members
    WHERE id = '17730000-0000-0000-0000-000000000001'
  ) THEN
    RAISE EXCEPTION 'FALHOU: alias removeu a identidade canônica que exerce';
  END IF;
  RAISE NOTICE 'OK: alias não remove a identidade canônica';
END;
$$;

-- ----- Criador tampouco se autoexclui, mas remove terceiro -----
SELECT set_config('request.jwt.claims',
  '{"sub":"17710000-0000-0000-0000-000000000004","supabase_uid":"17710000-0000-0000-0000-000000000004"}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.remove_project_member(
      '17730000-0000-0000-0000-000000000004');
    RAISE EXCEPTION 'FALHOU: criador removeu a própria membership';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;
SELECT * FROM public.remove_project_member(
  '17730000-0000-0000-0000-000000000005');
RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.project_members
    WHERE id = '17730000-0000-0000-0000-000000000004'
  ) THEN
    RAISE EXCEPTION 'FALHOU: criador conseguiu se autoexcluir';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.assignments
    WHERE id = '17750000-0000-0000-0000-000000000003'
  ) THEN
    RAISE EXCEPTION 'FALHOU: pendência não liberada na remoção pelo criador';
  END IF;

  RAISE NOTICE 'OK: criador não se autoexclui e a remoção de terceiro libera pendência';
END;
$$;

-- ----- Master é o break-glass: remove a própria membership -------------------
-- Isenção deliberada, alinhada com enforce_project_members_column_guard, que já
-- permite ao master mudar o próprio papel. Os DOIS lados precisam concordar: a
-- policy libera o DELETE e o guard da RPC não pode levantar 42501 em cima
-- disso, senão o mecanismo que existe para EXPLICAR o bloqueio vira o bloqueio.
-- Por isso o caso exercita a RPC (que devolve o project_id) e não só o DELETE.
SELECT set_config('request.jwt.claims',
  '{"sub":"17710000-0000-0000-0000-000000000006","supabase_uid":"17710000-0000-0000-0000-000000000006"}', true);
SET LOCAL ROLE authenticated;
SELECT * FROM public.remove_project_member(
  '17730000-0000-0000-0000-000000000006');
RESET ROLE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.project_members
    WHERE id = '17730000-0000-0000-0000-000000000006'
  ) THEN
    RAISE EXCEPTION 'FALHOU: master foi barrado ao remover a própria membership';
  END IF;
  RAISE NOTICE 'OK: master remove a própria membership (policy e guard concordam)';
END;
$$;

-- ----- Excluir o projeto continua possível: o cascade não passa pela RLS -----
-- Um trigger que levantasse exceção na autoidentidade quebraria este caminho,
-- que remove a membership do próprio dono por cascade.
DELETE FROM public.projects
WHERE id = '17700000-0000-0000-0000-000000000002';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.project_members
    WHERE project_id = '17700000-0000-0000-0000-000000000002'
  ) THEN
    RAISE EXCEPTION 'FALHOU: cascade do projeto não removeu as memberships';
  END IF;
  RAISE NOTICE 'OK: exclusão de projeto cascateia sem esbarrar na autoidentidade';
END;
$$;

ROLLBACK;
