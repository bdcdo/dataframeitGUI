-- Upgrade real da remoção transacional de membros (issue #177).
--
-- Este arquivo pressupõe exatamente o schema imediatamente anterior:
--   npx supabase db reset --local --no-seed --version 20260715160000
--   psql "$(npx supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '\"')" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/remove_project_member_invariants.upgrade.test.sql
--
-- As fixtures órfãs são válidas naquele schema. A migration real é incluída
-- depois delas e precisa sanear o legado antes de instalar as invariantes.

BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('17790000-0000-0000-0000-000000000001', 'issue177-upgrade-owner@example.test'),
  ('17790000-0000-0000-0000-000000000002', 'issue177-upgrade-orphan@example.test');

INSERT INTO public.projects (id, name, created_by) VALUES
  ('17790000-0000-0000-0000-000000000010',
   'Issue 177 - legacy upgrade',
   '17790000-0000-0000-0000-000000000001');

INSERT INTO public.documents (id, project_id, external_id, title, text) VALUES
  ('17790000-0000-0000-0000-000000000020',
   '17790000-0000-0000-0000-000000000010', '177-UP-1', 'Pendente órfã', 'texto'),
  ('17790000-0000-0000-0000-000000000021',
   '17790000-0000-0000-0000-000000000010', '177-UP-2', 'Histórico órfão', 'texto'),
  ('17790000-0000-0000-0000-000000000022',
   '17790000-0000-0000-0000-000000000010', '177-UP-3', 'Novo teste', 'texto');

-- O schema antigo aceita os três estados abaixo: alias e pendência sem linha
-- em project_members, além de histórico sem membership.
INSERT INTO public.member_email_links (
  id,
  project_id,
  member_user_id,
  email,
  linked_user_id,
  created_by
) VALUES (
  '17790000-0000-0000-0000-000000000030',
  '17790000-0000-0000-0000-000000000010',
  '17790000-0000-0000-0000-000000000002',
  'issue177-upgrade-alias@example.test',
  '17790000-0000-0000-0000-000000000002',
  '17790000-0000-0000-0000-000000000001'
);

INSERT INTO public.assignments (
  id,
  project_id,
  document_id,
  user_id,
  status,
  type
) VALUES
  ('17790000-0000-0000-0000-000000000040',
   '17790000-0000-0000-0000-000000000010',
   '17790000-0000-0000-0000-000000000020',
   '17790000-0000-0000-0000-000000000002',
   'pendente',
   'codificacao'),
  ('17790000-0000-0000-0000-000000000041',
   '17790000-0000-0000-0000-000000000010',
   '17790000-0000-0000-0000-000000000021',
   '17790000-0000-0000-0000-000000000002',
   'em_andamento',
   'codificacao');

\ir ../migrations/20260715170000_remove_project_member_invariants.sql

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.member_email_links
    WHERE id = '17790000-0000-0000-0000-000000000030'
  ) THEN
    RAISE EXCEPTION 'FALHOU upgrade: alias órfão não foi saneado';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.assignments
    WHERE id = '17790000-0000-0000-0000-000000000040'
  ) THEN
    RAISE EXCEPTION 'FALHOU upgrade: pendência órfã não voltou ao pool';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.assignments
    WHERE id = '17790000-0000-0000-0000-000000000041'
      AND status = 'em_andamento'
  ) THEN
    RAISE EXCEPTION 'FALHOU upgrade: histórico iniciado foi removido';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.member_email_links'::regclass
      AND conname = 'member_email_links_project_member_fkey'
      AND convalidated
  ) THEN
    RAISE EXCEPTION 'FALHOU upgrade: FK composta não foi criada e validada';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.assignments'::regclass
      AND tgname = 'enforce_pending_assignment_membership'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'FALHOU upgrade: trigger de pendência não foi criado';
  END IF;

  RAISE NOTICE 'OK upgrade: legado saneado, histórico preservado e invariantes instaladas';
END;
$$;

-- A FK precisa rejeitar a recriação do grant órfão.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.member_email_links (
      project_id,
      member_user_id,
      email,
      created_by
    ) VALUES (
      '17790000-0000-0000-0000-000000000010',
      '17790000-0000-0000-0000-000000000002',
      'issue177-upgrade-alias-2@example.test',
      '17790000-0000-0000-0000-000000000001'
    );
    RAISE EXCEPTION 'FALHOU upgrade: FK aceitou alias órfão';
  EXCEPTION
    WHEN foreign_key_violation THEN
      NULL;
  END;
END;
$$;

-- O trigger precisa rejeitar uma pendência nova, mas aceitar histórico.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.assignments (
      project_id,
      document_id,
      user_id,
      status,
      type
    ) VALUES (
      '17790000-0000-0000-0000-000000000010',
      '17790000-0000-0000-0000-000000000022',
      '17790000-0000-0000-0000-000000000002',
      'pendente',
      'codificacao'
    );
    RAISE EXCEPTION 'FALHOU upgrade: trigger aceitou pendência órfã';
  EXCEPTION
    WHEN foreign_key_violation THEN
      IF SQLERRM <> 'Assignment pendente exige membro ativo no mesmo projeto.' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE public.assignments
    SET status = 'pendente'
    WHERE id = '17790000-0000-0000-0000-000000000041';
    RAISE EXCEPTION 'FALHOU upgrade: UPDATE transformou histórico órfão em pendência';
  EXCEPTION
    WHEN foreign_key_violation THEN
      IF SQLERRM <> 'Assignment pendente exige membro ativo no mesmo projeto.' THEN
        RAISE;
      END IF;
  END;

  IF NOT EXISTS (
    SELECT 1
    FROM public.assignments
    WHERE id = '17790000-0000-0000-0000-000000000041'
      AND status = 'em_andamento'
  ) THEN
    RAISE EXCEPTION 'FALHOU upgrade: UPDATE rejeitado não preservou o histórico';
  END IF;

  INSERT INTO public.assignments (
    project_id,
    document_id,
    user_id,
    status,
    type
  ) VALUES (
    '17790000-0000-0000-0000-000000000010',
    '17790000-0000-0000-0000-000000000022',
    '17790000-0000-0000-0000-000000000002',
    'concluido',
    'codificacao'
  );

  RAISE NOTICE 'OK upgrade: INSERT/UPDATE órfãos bloqueados e histórico sem membership permitido';
END;
$$;

-- A limpeza vive na membership, não apenas na RPC: um DELETE direto também
-- libera pendências e aliases, mas conserva os dois registros históricos.
INSERT INTO public.project_members (id, project_id, user_id, role) VALUES (
  '17790000-0000-0000-0000-000000000050',
  '17790000-0000-0000-0000-000000000010',
  '17790000-0000-0000-0000-000000000002',
  'pesquisador'
);

INSERT INTO public.member_email_links (
  project_id,
  member_user_id,
  email,
  created_by
) VALUES (
  '17790000-0000-0000-0000-000000000010',
  '17790000-0000-0000-0000-000000000002',
  'issue177-upgrade-valid-alias@example.test',
  '17790000-0000-0000-0000-000000000001'
);

INSERT INTO public.assignments (
  id,
  project_id,
  document_id,
  user_id,
  status,
  type
) VALUES (
  '17790000-0000-0000-0000-000000000042',
  '17790000-0000-0000-0000-000000000010',
  '17790000-0000-0000-0000-000000000020',
  '17790000-0000-0000-0000-000000000002',
  'pendente',
  'codificacao'
);

DELETE FROM public.project_members
WHERE id = '17790000-0000-0000-0000-000000000050';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.assignments
    WHERE id = '17790000-0000-0000-0000-000000000042'
  ) OR EXISTS (
    SELECT 1
    FROM public.member_email_links
    WHERE email = 'issue177-upgrade-valid-alias@example.test'
  ) THEN
    RAISE EXCEPTION 'FALHOU upgrade: DELETE direto deixou pendência ou alias';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.assignments
    WHERE id = '17790000-0000-0000-0000-000000000041'
      AND status = 'em_andamento'
  ) THEN
    RAISE EXCEPTION 'FALHOU upgrade: DELETE direto removeu histórico';
  END IF;

  RAISE NOTICE 'OK upgrade: DELETE direto obedeceu ao contrato da membership';
END;
$$;

ROLLBACK;
