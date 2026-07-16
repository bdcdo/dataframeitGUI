-- Regressões do mapping Clerk, do protocolo de snapshot em duas fases e da
-- reconciliação integral de aliases. O arquivo roda numa transação e não deixa
-- fixtures no banco local.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute attribute
    WHERE attribute.attrelid = 'public.clerk_user_mapping'::regclass
      AND attribute.attname = 'access_sync_version'
      AND attribute.attnotnull
      AND NOT attribute.attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute attribute
    WHERE attribute.attrelid = 'public.clerk_user_mapping'::regclass
      AND attribute.attname = 'access_snapshot_version'
      AND attribute.attnotnull
      AND NOT attribute.attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute attribute
    WHERE attribute.attrelid = 'public.clerk_user_mapping'::regclass
      AND attribute.attname = 'clerk_deleted'
      AND attribute.attnotnull
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION 'FALHOU: markers Clerk NOT NULL não existem';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'public.clerk_user_mapping'::regclass
      AND constraint_row.confrelid = 'public.profiles'::regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.confdeltype = 'c'
  ) THEN
    RAISE EXCEPTION 'FALHOU: mapping não referencia profiles ON DELETE CASCADE';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'public.clerk_user_mapping'::regclass
      AND constraint_row.conname = 'clerk_user_mapping_deleted_marker_check'
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid)
        ILIKE '%NOT clerk_deleted%access_sync_version = 0%'
  ) THEN
    RAISE EXCEPTION 'FALHOU: mapping deletado ainda aceita marker ativo';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'auth.users'::regclass
      AND trigger_row.tgname = 'sync_claimable_preregistered_email_trigger'
      AND NOT trigger_row.tgisinternal
  ) OR pg_catalog.pg_get_functiondef(
    'public.sync_claimable_preregistered_email()'::regprocedure
  ) NOT ILIKE '%canonical-project-identity%'
    OR pg_catalog.pg_get_functiondef(
      'public.sync_claimable_preregistered_email()'::regprocedure
    ) NOT ILIKE '%update public.profiles%'
  THEN
    RAISE EXCEPTION 'FALHOU: correção de e-mail não serializa auth.users e profile';
  END IF;
END;
$$;

INSERT INTO auth.users (id, email) VALUES
  ('91000000-0000-0000-0000-000000000001', 'snapshot-account@example.test'),
  ('91000000-0000-0000-0000-000000000002', 'canonical-a@example.test'),
  ('91000000-0000-0000-0000-000000000003', 'canonical-b@example.test'),
  ('91000000-0000-0000-0000-000000000004', 'fixture-owner@example.test'),
  ('91000000-0000-0000-0000-000000000005', 'matrix-account@example.test'),
  ('91000000-0000-0000-0000-000000000006', 'cascade-account@example.test'),
  ('91000000-0000-0000-0000-000000000007', 'claim-pending@example.test'),
  ('91000000-0000-0000-0000-000000000008', 'claim-active@example.test'),
  ('91000000-0000-0000-0000-000000000009', 'proof-target@example.test'),
  ('91000000-0000-0000-0000-00000000000a', 'proof-source@example.test'),
  ('91000000-0000-0000-0000-00000000000b', 'proof-account@example.test'),
  ('91000000-0000-0000-0000-00000000000c', 'replay-account@example.test');

UPDATE public.profiles
SET activated_at = now()
WHERE id = '91000000-0000-0000-0000-000000000008';

UPDATE public.profiles
SET activated_at = now()
WHERE id = '91000000-0000-0000-0000-00000000000b';

INSERT INTO public.clerk_user_mapping (
  clerk_user_id,
  supabase_user_id,
  access_sync_version
) VALUES
  ('clerk_snapshot_test', '91000000-0000-0000-0000-000000000001', 1),
  ('clerk_matrix_old', '91000000-0000-0000-0000-000000000005', 1),
  ('clerk_cascade_test', '91000000-0000-0000-0000-000000000006', 0),
  ('clerk_active_owner', '91000000-0000-0000-0000-000000000008', 1),
  ('clerk_proof_account', '91000000-0000-0000-0000-00000000000b', 1),
  ('clerk_replay_test', '91000000-0000-0000-0000-00000000000c', 0);

UPDATE public.clerk_user_mapping
SET access_snapshot_version = 55
WHERE clerk_user_id = 'clerk_proof_account';

-- Somente placeholder pendente e sem mapping pode ser reclamado. Profile ativo
-- continua pertencendo ao Clerk original mesmo se outra conta reciclar o e-mail.
DO $$
DECLARE
  claimed_uid UUID;
BEGIN
  claimed_uid := public.claim_clerk_supabase_identity(
    'clerk_pending_owner',
    ' CLAIM-PENDING@EXAMPLE.TEST '
  );
  IF claimed_uid IS DISTINCT FROM
    '91000000-0000-0000-0000-000000000007'::uuid
  THEN
    RAISE EXCEPTION 'FALHOU claim: placeholder pendente não foi reclamado';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.clerk_user_mapping
    WHERE clerk_user_id = 'clerk_pending_owner'
      AND supabase_user_id = claimed_uid
      AND access_sync_version = 0
      AND NOT clerk_deleted
  ) THEN
    RAISE EXCEPTION 'FALHOU claim: mapping pendente não foi criado fechado';
  END IF;

  BEGIN
    PERFORM public.claim_clerk_supabase_identity(
      'clerk_recycled_email',
      'claim-active@example.test'
    );
    RAISE EXCEPTION 'TESTE FALHOU: profile ativo foi reclamado por e-mail';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  IF NOT EXISTS (
    SELECT 1
    FROM public.clerk_user_mapping
    WHERE clerk_user_id = 'clerk_active_owner'
      AND supabase_user_id = '91000000-0000-0000-0000-000000000008'
  ) OR EXISTS (
    SELECT 1
    FROM public.clerk_user_mapping
    WHERE clerk_user_id = 'clerk_recycled_email'
  ) THEN
    RAISE EXCEPTION 'FALHOU claim: e-mail histórico tomou identidade ativa';
  END IF;

  BEGIN
    PERFORM public.claim_clerk_supabase_identity(
      'clerk_second_pending_owner',
      'claim-pending@example.test'
    );
    RAISE EXCEPTION 'TESTE FALHOU: placeholder recebeu dois donos Clerk';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  RAISE NOTICE 'OK: claim só aceita placeholder pendente e sem mapping';
END;
$$;

-- A Auth Admin API atualiza auth.users numa transação própria. O trigger dessa
-- transação precisa sincronizar o profile e disputar a mesma trava do claim.
DO $$
BEGIN
  UPDATE auth.users
  SET email = ' CORRECTED-CANONICAL-A@EXAMPLE.TEST '
  WHERE id = '91000000-0000-0000-0000-000000000002';

  IF NOT EXISTS (
    SELECT 1
    FROM auth.users AS auth_user
    JOIN public.profiles AS profile ON profile.id = auth_user.id
    WHERE auth_user.id = '91000000-0000-0000-0000-000000000002'
      AND auth_user.email = 'corrected-canonical-a@example.test'
      AND profile.email = auth_user.email
  ) THEN
    RAISE EXCEPTION 'FALHOU e-mail: auth.users e profile não convergiram juntos';
  END IF;

  BEGIN
    UPDATE auth.users
    SET email = 'claimed-must-not-change@example.test'
    WHERE id = '91000000-0000-0000-0000-000000000007';
    RAISE EXCEPTION 'TESTE FALHOU: placeholder reclamado mudou de e-mail';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  BEGIN
    UPDATE auth.users
    SET email = 'active-must-not-change@example.test'
    WHERE id = '91000000-0000-0000-0000-000000000008';
    RAISE EXCEPTION 'TESTE FALHOU: profile ativo mudou e-mail de pré-registro';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  IF EXISTS (
    SELECT 1
    FROM auth.users AS auth_user
    JOIN public.profiles AS profile ON profile.id = auth_user.id
    WHERE auth_user.id IN (
      '91000000-0000-0000-0000-000000000007',
      '91000000-0000-0000-0000-000000000008'
    )
      AND auth_user.email IS DISTINCT FROM profile.email
  ) THEN
    RAISE EXCEPTION 'FALHOU e-mail: rejeição deixou auth.users e profile divergentes';
  END IF;

  RAISE NOTICE 'OK: correção de e-mail é atômica e exclusiva com o claim Clerk';
END;
$$;

INSERT INTO public.projects (id, name, created_by) VALUES
  ('91100000-0000-0000-0000-000000000001', 'aliases do mesmo target', '91000000-0000-0000-0000-000000000004'),
  ('91100000-0000-0000-0000-000000000002', 'aliases conflitantes', '91000000-0000-0000-0000-000000000004'),
  ('91100000-0000-0000-0000-000000000003', 'membership direta', '91000000-0000-0000-0000-000000000004'),
  ('91100000-0000-0000-0000-000000000004', 'alias revogado', '91000000-0000-0000-0000-000000000004'),
  ('91100000-0000-0000-0000-000000000005', 'provas versionadas', '91000000-0000-0000-0000-000000000004');

INSERT INTO public.project_members (project_id, user_id, role) VALUES
  ('91100000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000002', 'pesquisador'),
  ('91100000-0000-0000-0000-000000000002', '91000000-0000-0000-0000-000000000002', 'pesquisador'),
  ('91100000-0000-0000-0000-000000000002', '91000000-0000-0000-0000-000000000003', 'pesquisador'),
  ('91100000-0000-0000-0000-000000000003', '91000000-0000-0000-0000-000000000001', 'pesquisador'),
  ('91100000-0000-0000-0000-000000000003', '91000000-0000-0000-0000-000000000002', 'pesquisador'),
  ('91100000-0000-0000-0000-000000000004', '91000000-0000-0000-0000-000000000002', 'pesquisador'),
  ('91100000-0000-0000-0000-000000000005', '91000000-0000-0000-0000-000000000009', 'coordenador');

-- A versão do snapshot ou o estado reclamável é parte da própria escrita.
-- As três operações rejeitam prova stale antes de criar acesso ou migrar
-- trabalho; não existe check-then-write fora da trava global.
DO $$
DECLARE
  v_link public.member_email_links;
BEGIN
  PERFORM public.add_project_member_with_identity_proof(
    '91100000-0000-0000-0000-000000000005',
    '91000000-0000-0000-0000-00000000000a',
    'pesquisador',
    'proof-source@example.test',
    NULL
  );

  SELECT * INTO STRICT v_link
  FROM public.write_member_email_link_with_identity_proof(
    '91100000-0000-0000-0000-000000000005',
    '91000000-0000-0000-0000-000000000009',
    'proof-alias@example.test',
    '91000000-0000-0000-0000-00000000000b',
    '91000000-0000-0000-0000-000000000004',
    NULL,
    NULL,
    55
  );
  IF v_link.linked_user_id IS DISTINCT FROM
    '91000000-0000-0000-0000-00000000000b'::uuid
  THEN
    RAISE EXCEPTION 'FALHOU prova: snapshot atual não criou o alias';
  END IF;

  BEGIN
    PERFORM public.add_project_member_with_identity_proof(
      '91100000-0000-0000-0000-000000000005',
      '91000000-0000-0000-0000-00000000000b',
      'pesquisador',
      'proof-account@example.test',
      54
    );
    RAISE EXCEPTION 'TESTE FALHOU: add aceitou snapshot stale';
  EXCEPTION
    WHEN serialization_failure THEN
      NULL;
  END;

  BEGIN
    PERFORM public.write_member_email_link_with_identity_proof(
      '91100000-0000-0000-0000-000000000005',
      '91000000-0000-0000-0000-000000000009',
      'proof-stale@example.test',
      '91000000-0000-0000-0000-00000000000b',
      '91000000-0000-0000-0000-000000000004',
      NULL,
      NULL,
      54
    );
    RAISE EXCEPTION 'TESTE FALHOU: link aceitou snapshot stale';
  EXCEPTION
    WHEN serialization_failure THEN
      NULL;
  END;

  UPDATE auth.users
  SET email = 'proof-source-corrected@example.test'
  WHERE id = '91000000-0000-0000-0000-00000000000a';

  BEGIN
    PERFORM public.unify_project_members(
      '91100000-0000-0000-0000-000000000005',
      '91000000-0000-0000-0000-00000000000a',
      '91000000-0000-0000-0000-000000000009',
      '91000000-0000-0000-0000-00000000000a',
      'proof-source@example.test',
      '91000000-0000-0000-0000-000000000004',
      NULL
    );
    RAISE EXCEPTION 'TESTE FALHOU: unify aceitou placeholder stale';
  EXCEPTION
    WHEN serialization_failure THEN
      NULL;
  END;

  IF EXISTS (
    SELECT 1 FROM public.project_members
    WHERE project_id = '91100000-0000-0000-0000-000000000005'
      AND user_id = '91000000-0000-0000-0000-00000000000b'
  ) OR EXISTS (
    SELECT 1 FROM public.member_email_links
    WHERE project_id = '91100000-0000-0000-0000-000000000005'
      AND email = 'proof-stale@example.test'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.project_members
    WHERE project_id = '91100000-0000-0000-0000-000000000005'
      AND user_id = '91000000-0000-0000-0000-00000000000a'
  ) THEN
    RAISE EXCEPTION 'FALHOU prova: escrita stale deixou efeitos';
  END IF;

  RAISE NOTICE 'OK: writes de identidade rejeitam snapshot e placeholder stale';
END;
$$;

INSERT INTO public.member_email_links (
  id,
  project_id,
  member_user_id,
  email,
  linked_user_id,
  created_by
) VALUES
  ('91200000-0000-0000-0000-000000000001', '91100000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000002', 'snapshot-v100@example.test', '91000000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000004'),
  ('91200000-0000-0000-0000-000000000002', '91100000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000002', 'snapshot-v200-a@example.test', NULL, '91000000-0000-0000-0000-000000000004'),
  ('91200000-0000-0000-0000-000000000003', '91100000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000002', 'snapshot-v200-b@example.test', NULL, '91000000-0000-0000-0000-000000000004'),
  ('91200000-0000-0000-0000-000000000004', '91100000-0000-0000-0000-000000000002', '91000000-0000-0000-0000-000000000002', 'conflict-a@example.test', NULL, '91000000-0000-0000-0000-000000000004'),
  ('91200000-0000-0000-0000-000000000005', '91100000-0000-0000-0000-000000000002', '91000000-0000-0000-0000-000000000003', 'conflict-b@example.test', NULL, '91000000-0000-0000-0000-000000000004'),
  ('91200000-0000-0000-0000-000000000006', '91100000-0000-0000-0000-000000000003', '91000000-0000-0000-0000-000000000002', 'direct-membership@example.test', NULL, '91000000-0000-0000-0000-000000000004'),
  ('91200000-0000-0000-0000-000000000007', '91100000-0000-0000-0000-000000000004', '91000000-0000-0000-0000-000000000002', 'revocation@example.test', '91000000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000004');

-- clerk_uid só aceita a interseção exata de subject, UID, mapping atual e
-- snapshot concluído. Chaves são imutáveis e exclusão é terminal.
DO $$
BEGIN
  PERFORM pg_catalog.set_config(
    'request.jwt.claims',
    '{"sub":"clerk_matrix_old","supabase_uid":"91000000-0000-0000-0000-000000000005"}',
    true
  );
  IF public.clerk_uid() IS DISTINCT FROM '91000000-0000-0000-0000-000000000005'::uuid THEN
    RAISE EXCEPTION 'FALHOU matrix: JWT coerente não resolveu UID';
  END IF;

  PERFORM pg_catalog.set_config(
    'request.jwt.claims',
    '{"sub":"clerk_matrix_wrong","supabase_uid":"91000000-0000-0000-0000-000000000005"}',
    true
  );
  IF public.clerk_uid() IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU matrix: subject sem mapping foi aceito';
  END IF;

  PERFORM pg_catalog.set_config(
    'request.jwt.claims',
    '{"sub":"clerk_matrix_old","supabase_uid":"91000000-0000-0000-0000-000000000001"}',
    true
  );
  IF public.clerk_uid() IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU matrix: UID divergente do mapping foi aceito';
  END IF;

  BEGIN
    UPDATE public.clerk_user_mapping
    SET clerk_deleted = true
    WHERE clerk_user_id = 'clerk_matrix_old';
    RAISE EXCEPTION 'TESTE FALHOU: mapping deletado conservou marker ativo';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  UPDATE public.clerk_user_mapping
  SET access_sync_version = 0
  WHERE clerk_user_id = 'clerk_matrix_old';
  PERFORM pg_catalog.set_config(
    'request.jwt.claims',
    '{"sub":"clerk_matrix_old","supabase_uid":"91000000-0000-0000-0000-000000000005"}',
    true
  );
  IF public.clerk_uid() IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU matrix: snapshot incompleto foi aceito';
  END IF;

  BEGIN
    UPDATE public.clerk_user_mapping
    SET clerk_user_id = 'clerk_matrix_new'
    WHERE clerk_user_id = 'clerk_matrix_old';
    RAISE EXCEPTION 'TESTE FALHOU: subject do mapping foi reatribuído';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  UPDATE public.clerk_user_mapping
  SET clerk_deleted = true
  WHERE clerk_user_id = 'clerk_matrix_old';

  BEGIN
    UPDATE public.clerk_user_mapping
    SET clerk_deleted = false
    WHERE clerk_user_id = 'clerk_matrix_old';
    RAISE EXCEPTION 'TESTE FALHOU: mapping excluído foi reativado';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  IF public.clerk_uid() IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU matrix: mapping excluído continuou autenticável';
  END IF;

  PERFORM pg_catalog.set_config('request.jwt.claims', '{}', true);
  RAISE NOTICE 'OK: matrix JWT/mapping falha fechada e exclusão é terminal';
END;
$$;

-- A falha artificial acontece dentro da segunda fase. O bloco EXCEPTION cria
-- um savepoint: os efeitos do complete voltam, mas o begin anterior permanece
-- em marker 0/generation 100, como ocorreria entre duas transações da API.
CREATE OR REPLACE FUNCTION pg_temp.fail_snapshot_profile_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id = '91000000-0000-0000-0000-000000000001'::uuid THEN
    RAISE EXCEPTION 'falha forçada no complete';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER fail_snapshot_profile_update_trigger
BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_snapshot_profile_update();

DO $$
DECLARE
  v_failed boolean := false;
BEGIN
  IF NOT public.begin_clerk_access_snapshot(
    'clerk_snapshot_test',
    '91000000-0000-0000-0000-000000000001',
    100,
    ARRAY['snapshot-v100@example.test']
  ) THEN
    RAISE EXCEPTION 'FALHOU protocolo: begin 100 recusado';
  END IF;

  BEGIN
    PERFORM public.complete_clerk_access_snapshot(
      'clerk_snapshot_test',
      '91000000-0000-0000-0000-000000000001',
      100,
      ARRAY['snapshot-v100@example.test'],
      'Nome 100',
      'Snapshot',
      true
    );
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM <> 'falha forçada no complete' THEN
        RAISE;
      END IF;
      v_failed := true;
  END;

  IF NOT v_failed OR NOT EXISTS (
    SELECT 1
    FROM public.clerk_user_mapping
    WHERE clerk_user_id = 'clerk_snapshot_test'
      AND access_sync_version = 0
      AND access_snapshot_version = 100
      AND NOT clerk_deleted
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.member_email_links
    WHERE email = 'snapshot-v100@example.test'
      AND linked_user_id = '91000000-0000-0000-0000-000000000001'
  ) OR EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = '91000000-0000-0000-0000-000000000001'
      AND first_name = 'Nome 100'
  ) THEN
    RAISE EXCEPTION 'FALHOU protocolo: complete falho não preservou marker 0/generation 100';
  END IF;

  RAISE NOTICE 'OK: falha do complete preserva geração escolhida com marker 0';
END;
$$;

DROP TRIGGER fail_snapshot_profile_update_trigger ON public.profiles;

-- Replay da MESMA geração já concluída. O Svix entrega at-least-once e a versão
-- é o `updatedAt` do Clerk, então a reentrega é rotina — e o begin só comparava
-- `>`, deixando `V > V` falso: a reentrega seguia para o UPDATE incondicional e
-- zerava o marker de uma conta sincronizada, revogando o acesso dela até um
-- retry concluir a segunda fase (ou para sempre, se ela falhasse).
-- Conta dedicada: o teste precisa concluir uma geração para reentregá-la, e
-- fazer isso na conta compartilhada avançaria a generation dela e quebraria o
-- protocolo 100→200 exercitado logo abaixo (foi exatamente o que aconteceu
-- quando este bloco usava clerk_snapshot_test com geração 300).
DO $$
DECLARE
  v_sync_version integer;
BEGIN
  IF NOT public.begin_clerk_access_snapshot(
    'clerk_replay_test',
    '91000000-0000-0000-0000-00000000000c',
    300,
    ARRAY['replay-account@example.test']
  ) OR NOT public.complete_clerk_access_snapshot(
    'clerk_replay_test',
    '91000000-0000-0000-0000-00000000000c',
    300,
    ARRAY['replay-account@example.test'],
    'Nome 300',
    'Replay',
    true
  ) THEN
    RAISE EXCEPTION 'FALHOU replay: não consegui sincronizar a geração 300';
  END IF;

  IF public.begin_clerk_access_snapshot(
    'clerk_replay_test',
    '91000000-0000-0000-0000-00000000000c',
    300,
    ARRAY['replay-account@example.test']
  ) THEN
    RAISE EXCEPTION
      'FALHOU replay: begin aceitou reentrega de uma geração já concluída';
  END IF;

  SELECT access_sync_version
  INTO v_sync_version
  FROM public.clerk_user_mapping
  WHERE clerk_user_id = 'clerk_replay_test';

  IF v_sync_version <> 1 THEN
    RAISE EXCEPTION
      'FALHOU replay: reentrega derrubou o marker para %, revogando o acesso',
      v_sync_version;
  END IF;

  RAISE NOTICE 'OK: replay da geração concluída é no-op e preserva o acesso';
END;
$$;

-- Revogação por posse mora na fase 1: quando um e-mail migra de conta e o
-- snapshot do novo dono nunca conclui a fase 2 (superseded, clerk_deleted,
-- falha), o dono anterior não pode conservar um link que resolve para a
-- identidade do membro. O begin sozinho revoga o dono anterior e os links da
-- própria conta para e-mails que saíram; a concessão fica pendente
-- (fail-closed) até um complete.
INSERT INTO auth.users (id, email) VALUES
  ('91000000-0000-0000-0000-00000000000d', 'possession-old-owner@example.test'),
  ('91000000-0000-0000-0000-00000000000e', 'possession-new-owner@example.test');

INSERT INTO public.clerk_user_mapping (
  clerk_user_id,
  supabase_user_id,
  access_sync_version
) VALUES
  ('clerk_possession_test', '91000000-0000-0000-0000-00000000000e', 0);

INSERT INTO public.member_email_links (
  id,
  project_id,
  member_user_id,
  email,
  linked_user_id,
  created_by
) VALUES
  ('91200000-0000-0000-0000-000000000011', '91100000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000002', 'possession-migrated@example.test', '91000000-0000-0000-0000-00000000000d', '91000000-0000-0000-0000-000000000004'),
  ('91200000-0000-0000-0000-000000000012', '91100000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000002', 'possession-stale@example.test', '91000000-0000-0000-0000-00000000000e', '91000000-0000-0000-0000-000000000004');

DO $$
BEGIN
  -- Caixa alta e espaços provam que o begin normaliza igual à reconciliação.
  IF NOT public.begin_clerk_access_snapshot(
    'clerk_possession_test',
    '91000000-0000-0000-0000-00000000000e',
    100,
    ARRAY['  POSSESSION-MIGRATED@EXAMPLE.TEST  ']
  ) THEN
    RAISE EXCEPTION 'FALHOU posse: begin da conta nova foi recusado';
  END IF;

  -- Nenhum complete rodou: o dono anterior já perdeu a resolução e o link
  -- stale da própria conta caiu junto. A concessão ao novo dono continua
  -- pendente.
  IF EXISTS (
    SELECT 1
    FROM public.member_email_links
    WHERE email = 'possession-migrated@example.test'
      AND linked_user_id IS NOT NULL
  ) OR EXISTS (
    SELECT 1
    FROM public.member_email_links
    WHERE email = 'possession-stale@example.test'
      AND linked_user_id IS NOT NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.clerk_user_mapping
    WHERE clerk_user_id = 'clerk_possession_test'
      AND access_sync_version = 0
      AND access_snapshot_version = 100
  ) THEN
    RAISE EXCEPTION
      'FALHOU posse: begin sem complete deixou acesso residual ou concedeu';
  END IF;

  RAISE NOTICE 'OK: fase 1 revoga por posse; sem complete não há acesso residual';
END;
$$;

DO $$
DECLARE
  v_uid uuid;
BEGIN
  IF NOT public.begin_clerk_access_snapshot(
    'clerk_snapshot_test',
    '91000000-0000-0000-0000-000000000001',
    100,
    ARRAY['snapshot-v100@example.test']
  ) OR NOT public.begin_clerk_access_snapshot(
    'clerk_snapshot_test',
    '91000000-0000-0000-0000-000000000001',
    200,
    ARRAY['snapshot-v200-a@example.test', 'snapshot-v200-b@example.test', 'conflict-a@example.test', 'conflict-b@example.test', 'direct-membership@example.test', 'revocation@example.test']
  ) THEN
    RAISE EXCEPTION 'FALHOU protocolo: begin 100/200 não foi monotônico';
  END IF;

  IF public.complete_clerk_access_snapshot(
    'clerk_snapshot_test',
    '91000000-0000-0000-0000-000000000001',
    100,
    ARRAY['snapshot-v100@example.test'],
    'Nome obsoleto',
    'Snapshot',
    true
  ) THEN
    RAISE EXCEPTION 'FALHOU protocolo: complete 100 venceu generation 200';
  END IF;

  IF NOT public.complete_clerk_access_snapshot(
    'clerk_snapshot_test',
    '91000000-0000-0000-0000-000000000001',
    200,
    ARRAY[
      ' SNAPSHOT-V200-A@EXAMPLE.TEST ',
      'snapshot-v200-b@example.test',
      'snapshot-v200-b@example.test',
      'conflict-a@example.test',
      'conflict-b@example.test',
      'direct-membership@example.test',
      'revocation@example.test'
    ],
    'Nome 200',
    'Snapshot',
    true
  ) THEN
    RAISE EXCEPTION 'FALHOU protocolo: complete 200 recusado';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.clerk_user_mapping
    WHERE clerk_user_id = 'clerk_snapshot_test'
      AND access_sync_version = 1
      AND access_snapshot_version = 200
      AND NOT clerk_deleted
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = '91000000-0000-0000-0000-000000000001'
      AND first_name = 'Nome 200'
      AND last_name = 'Snapshot'
      AND activated_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'FALHOU protocolo: complete 200 não publicou profile e marker';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.member_email_links
    WHERE email = 'snapshot-v100@example.test'
      AND linked_user_id IS NOT NULL
  ) OR (
    SELECT count(*)
    FROM public.member_email_links
    WHERE email IN (
      'snapshot-v200-a@example.test',
      'snapshot-v200-b@example.test',
      'revocation@example.test'
    )
      AND linked_user_id = '91000000-0000-0000-0000-000000000001'
  ) <> 3 THEN
    RAISE EXCEPTION 'FALHOU aliases: snapshot 200 não substituiu integralmente o 100';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.member_email_links
    WHERE email IN ('conflict-a@example.test', 'conflict-b@example.test')
      AND linked_user_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'FALHOU aliases: conflito de targets escolheu identidade arbitrária';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.member_email_links
    WHERE email = 'direct-membership@example.test'
      AND linked_user_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'FALHOU aliases: membership direta coexistiu com alias';
  END IF;

  IF public.begin_clerk_access_snapshot(
    'clerk_snapshot_test',
    '91000000-0000-0000-0000-000000000001',
    199,
    ARRAY[]::TEXT[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.clerk_user_mapping
    WHERE clerk_user_id = 'clerk_snapshot_test'
      AND access_sync_version = 1
      AND access_snapshot_version = 200
  ) THEN
    RAISE EXCEPTION 'FALHOU protocolo: begin obsoleto derrubou snapshot publicado';
  END IF;

  PERFORM pg_catalog.set_config(
    'request.jwt.claims',
    '{"sub":"clerk_snapshot_test","supabase_uid":"91000000-0000-0000-0000-000000000001"}',
    true
  );
  IF public.clerk_uid() IS DISTINCT FROM '91000000-0000-0000-0000-000000000001'::uuid THEN
    RAISE EXCEPTION 'FALHOU protocolo: snapshot concluído não liberou clerk_uid';
  END IF;

  PERFORM pg_catalog.set_config('request.jwt.claims', '{}', true);
  v_uid := public.begin_clerk_user_revocation('clerk_snapshot_test');
  IF v_uid IS DISTINCT FROM '91000000-0000-0000-0000-000000000001'::uuid OR NOT EXISTS (
    SELECT 1
    FROM public.clerk_user_mapping
    WHERE clerk_user_id = 'clerk_snapshot_test'
      AND access_sync_version = 0
      AND clerk_deleted
  ) THEN
    RAISE EXCEPTION 'FALHOU revogação: begin não publicou estado terminal';
  END IF;

  PERFORM pg_catalog.set_config(
    'request.jwt.claims',
    '{"sub":"clerk_snapshot_test","supabase_uid":"91000000-0000-0000-0000-000000000001"}',
    true
  );
  IF public.clerk_uid() IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU revogação: JWT continuou válido após begin';
  END IF;
  PERFORM pg_catalog.set_config('request.jwt.claims', '{}', true);

  IF public.complete_clerk_user_revocation(
    'clerk_snapshot_test',
    '91000000-0000-0000-0000-000000000005'
  ) OR NOT public.complete_clerk_user_revocation(
    'clerk_snapshot_test',
    '91000000-0000-0000-0000-000000000001'
  ) THEN
    RAISE EXCEPTION 'FALHOU revogação: complete não validou identidade exata';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.member_email_links
    WHERE linked_user_id = '91000000-0000-0000-0000-000000000001'
  ) OR public.begin_clerk_access_snapshot(
    'clerk_snapshot_test',
    '91000000-0000-0000-0000-000000000001',
    300,
    ARRAY['snapshot-v300@example.test']
  ) OR public.complete_clerk_access_snapshot(
    'clerk_snapshot_test',
    '91000000-0000-0000-0000-000000000001',
    200,
    ARRAY['snapshot-v200-a@example.test'],
    'Nome tardio',
    'Snapshot',
    true
  ) OR public.begin_clerk_user_revocation('clerk_inexistente') IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU revogação: efeitos ou chamadas tardias não falharam fechados';
  END IF;

  RAISE NOTICE 'OK: snapshot mais novo vence e revogação é terminal';
END;
$$;

-- A FK de profile continua sendo a fonte única do ciclo de vida do mapping.
DELETE FROM public.profiles
WHERE id = '91000000-0000-0000-0000-000000000006';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.clerk_user_mapping
    WHERE clerk_user_id = 'clerk_cascade_test'
  ) THEN
    RAISE EXCEPTION 'FALHOU: exclusão do profile não removeu o mapping';
  END IF;
  RAISE NOTICE 'OK: mapping acompanha o ciclo de vida do profile';
END;
$$;

ROLLBACK;
