-- Identidade canônica de projeto: uma conta vinculada herda acesso, papel e
-- can_resolve exclusivamente do membro-alvo em cada projeto. A conta bruta
-- continua sendo a fonte de autoria global e de ownership em projects.

BEGIN;

-- A migration participa da mesma ordem de locks das operações de identidade:
-- advisory global primeiro, tabelas depois. Assim um deploy não pode formar
-- ciclo com unificação ou criação de membership que já esteja em voo.
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('canonical-project-identity', 0)
);

-- O preflight precisa observar um snapshot estável: estas invariantes não são
-- todas expressáveis por constraints declarativas. O modo escolhido bloqueia
-- DML concorrente sem impedir leituras durante a migration transacional.
LOCK TABLE
  public.member_email_links,
  public.project_members,
  public.field_reviews
IN SHARE ROW EXCLUSIVE MODE;

-- ========== 0. Mapping Clerk concluído e ancorado em profiles ==========
-- auth.users sozinho não representa uma identidade utilizável pela aplicação.
-- O preflight recusa mappings órfãos antes de substituir a FK; a nova versão
-- de sync só é publicada depois que profile e aliases convergiram.
LOCK TABLE public.clerk_user_mapping IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.clerk_user_mapping mapping
    LEFT JOIN public.profiles profile
      ON profile.id = mapping.supabase_user_id
    WHERE profile.id IS NULL
  ) THEN
    RAISE EXCEPTION
      'clerk_user_mapping contém identidade sem profile'
      USING ERRCODE = '23503';
  END IF;
END;
$$;

ALTER TABLE public.clerk_user_mapping
  ADD COLUMN access_sync_version INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN access_snapshot_version BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN clerk_deleted BOOLEAN NOT NULL DEFAULT false,
  DROP CONSTRAINT IF EXISTS clerk_user_mapping_supabase_user_id_fkey,
  ADD CONSTRAINT clerk_user_mapping_supabase_user_id_fkey
  FOREIGN KEY (supabase_user_id)
  REFERENCES public.profiles(id)
  ON DELETE CASCADE;

ALTER TABLE public.clerk_user_mapping
  ADD CONSTRAINT clerk_user_mapping_deleted_marker_check
  CHECK (NOT clerk_deleted OR access_sync_version = 0);

-- Sem este backfill o DEFAULT 0 revogaria todo acesso no instante da migration:
-- clerk_uid() exige access_sync_version >= 1, e is_master() deriva de
-- clerk_uid(), então nem o master conseguiria reconciliar as contas presas. Os
-- mappings pré-existentes já eram a fonte de verdade antes deste schema, então
-- marcá-los como concluídos preserva o estado atual; a exigência de snapshot
-- Clerk verificado passa a valer no próximo reconcile de cada conta, que
-- regrava a versão a partir do estado real do Clerk.
UPDATE public.clerk_user_mapping
  SET access_sync_version = 1
  WHERE NOT clerk_deleted;

-- A ligação Clerk↔Supabase é permanente. Exclusão revoga o acesso sem liberar
-- o UUID para outra conta; placeholders ainda não reclamados não têm mapping.
CREATE OR REPLACE FUNCTION public.enforce_clerk_mapping_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.clerk_user_id IS DISTINCT FROM OLD.clerk_user_id
     OR NEW.supabase_user_id IS DISTINCT FROM OLD.supabase_user_id
  THEN
    RAISE EXCEPTION 'a identidade de um mapping Clerk-Supabase é imutável'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.clerk_deleted AND NOT NEW.clerk_deleted THEN
    RAISE EXCEPTION 'um mapping Clerk excluído não pode ser reativado'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_clerk_mapping_identity()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS enforce_clerk_mapping_identity_trigger
  ON public.clerk_user_mapping;
CREATE TRIGGER enforce_clerk_mapping_identity_trigger
  BEFORE UPDATE OF clerk_user_id, supabase_user_id, clerk_deleted
  ON public.clerk_user_mapping
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_clerk_mapping_identity();

-- Reivindica somente um placeholder pendente e ainda sem dono. `profiles.email`
-- pode ser histórico depois da ativação, portanto nunca autoriza reatribuir um
-- UUID ativo a outra conta Clerk.
CREATE OR REPLACE FUNCTION public.claim_clerk_supabase_identity(
  p_clerk_user_id TEXT,
  p_email TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_email TEXT := pg_catalog.lower(pg_catalog.btrim(p_email));
  v_existing_uid UUID;
  v_profile_id UUID;
  v_activated_at TIMESTAMPTZ;
  v_profile_count INTEGER;
BEGIN
  IF NULLIF(v_email, '') IS NULL THEN
    RAISE EXCEPTION 'e-mail canônico é obrigatório'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('canonical-project-identity', 0)
  );

  SELECT mapping.supabase_user_id
  INTO v_existing_uid
  FROM public.clerk_user_mapping mapping
  WHERE mapping.clerk_user_id = p_clerk_user_id
  FOR UPDATE;

  IF FOUND THEN
    RETURN v_existing_uid;
  END IF;

  -- Trava todos os candidatos antes de contar: duplicidade administrativa de
  -- profile também falha fechada, sem escolher um UUID arbitrário.
  PERFORM 1
  FROM public.profiles profile
  WHERE pg_catalog.lower(pg_catalog.btrim(profile.email)) = v_email
  ORDER BY profile.id
  FOR UPDATE;

  SELECT count(*)
  INTO v_profile_count
  FROM public.profiles profile
  WHERE pg_catalog.lower(pg_catalog.btrim(profile.email)) = v_email;

  IF v_profile_count = 0 THEN
    RETURN NULL;
  END IF;
  IF v_profile_count > 1 THEN
    RAISE EXCEPTION 'mais de um profile possui o e-mail informado'
      USING ERRCODE = '23514';
  END IF;

  SELECT profile.id, profile.activated_at
  INTO STRICT v_profile_id, v_activated_at
  FROM public.profiles profile
  WHERE pg_catalog.lower(pg_catalog.btrim(profile.email)) = v_email;

  IF v_activated_at IS NOT NULL THEN
    RAISE EXCEPTION 'profile ativo não pode ser reclamado por e-mail'
      USING ERRCODE = '23514';
  END IF;

  -- Placeholder cujo membro já trabalha via vínculo resolvido não está livre:
  -- activated_at fica NULL nesse arranjo (a ativação é da conta-alias), mas
  -- concedê-lo a um novo cadastro poria duas pessoas escrevendo como o MESMO
  -- member_user_id — o alias continua resolvendo para a primeira. Fail-closed;
  -- o coordenador resolve desfazendo o vínculo antes, se for intencional.
  IF EXISTS (
    SELECT 1
    FROM public.member_email_links link
    WHERE link.member_user_id = v_profile_id
      AND link.linked_user_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'placeholder com vínculo de e-mail resolvido não pode ser reclamado'
      USING ERRCODE = '23514';
  END IF;

  PERFORM 1
  FROM public.clerk_user_mapping mapping
  WHERE mapping.supabase_user_id = v_profile_id
  FOR UPDATE;

  IF FOUND THEN
    RAISE EXCEPTION 'placeholder já pertence a outra conta Clerk'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.clerk_user_mapping (
    clerk_user_id,
    supabase_user_id,
    access_sync_version,
    access_snapshot_version,
    clerk_deleted
  ) VALUES (
    p_clerk_user_id,
    v_profile_id,
    0,
    0,
    false
  );

  RETURN v_profile_id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_clerk_supabase_identity(TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_clerk_supabase_identity(TEXT, TEXT)
  TO service_role;

-- A correção de e-mail do pré-registro passa pela Auth Admin API. O trigger
-- participa da própria transação de auth.users e toma a mesma trava do claim
-- Clerk; portanto não existe intervalo entre "ainda não mapeado" e a troca do
-- e-mail. profiles.email converge na mesma transação, sem uma segunda escrita
-- da aplicação que pudesse deixar as duas representações divergentes.
CREATE OR REPLACE FUNCTION public.sync_claimable_preregistered_email()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_email TEXT := pg_catalog.lower(pg_catalog.btrim(NEW.email));
  v_activated_at TIMESTAMPTZ;
BEGIN
  IF NEW.email IS NOT DISTINCT FROM OLD.email THEN
    RETURN NEW;
  END IF;

  IF NULLIF(v_email, '') IS NULL THEN
    RAISE EXCEPTION 'e-mail canônico é obrigatório'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('canonical-project-identity', 0)
  );

  SELECT profile.activated_at
  INTO v_activated_at
  FROM public.profiles AS profile
  WHERE profile.id = OLD.id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'auth.users não possui profile correspondente'
      USING ERRCODE = '23503';
  END IF;

  IF v_activated_at IS NOT NULL THEN
    RAISE EXCEPTION 'conta ativa não pode alterar e-mail de pré-registro'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.clerk_user_mapping AS mapping
    WHERE mapping.supabase_user_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'placeholder reclamado não pode alterar o e-mail'
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.profiles
  SET email = v_email
  WHERE id = OLD.id;

  NEW.email := v_email;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_claimable_preregistered_email()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS sync_claimable_preregistered_email_trigger
  ON auth.users;
CREATE TRIGGER sync_claimable_preregistered_email_trigger
  BEFORE UPDATE OF email ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_claimable_preregistered_email();

-- O claim supabase_uid deixa de ser autoridade isolada. Um JWT antigo pode
-- conservar metadata depois que o profile foi reatribuído a outra conta Clerk;
-- a RLS só reconhece a identidade quando subject, claim, mapping e marker de
-- conclusão continuam coerentes no estado atual do banco.
CREATE OR REPLACE FUNCTION public.clerk_uid()
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT mapping.supabase_user_id
  FROM public.clerk_user_mapping mapping
  WHERE mapping.clerk_user_id = auth.jwt()->>'sub'
    AND mapping.supabase_user_id::text = auth.jwt()->>'supabase_uid'
    AND mapping.access_sync_version >= 1
    AND NOT mapping.clerk_deleted
$$;

GRANT EXECUTE ON FUNCTION public.clerk_uid()
  TO anon, authenticated, service_role;

-- ========== 1. Invariantes de member_email_links ==========
-- A policy "Coordinators manage member_email_links" é FOR ALL sem WITH CHECK,
-- então o Postgres reusa o USING no INSERT/UPDATE e um coordenador poderia
-- gravar a linha direto pelo PostgREST, sem passar por
-- write_member_email_link_with_identity_proof — isto é, vinculando uma conta
-- qualquer como alias de um membro sem nenhuma prova de posse do e-mail, e
-- passando a escrever como aquele membro. Os default privileges do Supabase
-- concedem DML no schema public (é por isso que clerk_user_mapping e
-- master_users revogam explicitamente), então o REVOKE é o que de fato torna a
-- RPC o único caminho que cria ou altera um alias.
--
-- DELETE continua com authenticated: unlinkMemberEmail o usa pelo cliente de
-- sessão, e apagar um vínculo só remove identidade — não confere nenhuma. A
-- policy de coordenador já restringe o alcance ao próprio projeto. SELECT
-- também fica: a leitura é decidida pela RLS.
REVOKE INSERT, UPDATE ON public.member_email_links
  FROM anon, authenticated;

-- A migration aborta diante de dados malformados. Não há escolha automática
-- de um alias "vencedor" nem remoção silenciosa de vínculos.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.member_email_links
    WHERE email = ''
      OR email IS DISTINCT FROM pg_catalog.lower(pg_catalog.btrim(email))
  ) THEN
    RAISE EXCEPTION
      'member_email_links contém e-mail não canônico'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.member_email_links mel
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.project_members pm
      WHERE pm.project_id = mel.project_id
        AND pm.user_id = mel.member_user_id
    )
  ) THEN
    RAISE EXCEPTION
      'member_email_links contém membro canônico fora de project_members'
      USING ERRCODE = '23503';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.member_email_links
    WHERE linked_user_id = member_user_id
  ) THEN
    RAISE EXCEPTION
      'member_email_links contém vínculo da conta para ela própria'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.member_email_links
    WHERE linked_user_id IS NOT NULL
    GROUP BY linked_user_id, project_id
    HAVING count(DISTINCT member_user_id) > 1
  ) THEN
    RAISE EXCEPTION
      'member_email_links contém mais de uma identidade canônica para a mesma conta no projeto'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.member_email_links alias_link
    JOIN public.member_email_links canonical_link
      ON canonical_link.project_id = alias_link.project_id
     AND canonical_link.member_user_id = alias_link.linked_user_id
    WHERE alias_link.linked_user_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'member_email_links contém identidade intermediária em uma cadeia de aliases'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.field_reviews fr
    WHERE fr.final_verdict IS NULL
      AND fr.arbitrator_id = fr.self_reviewer_id
  ) THEN
    RAISE EXCEPTION
      'field_reviews contém autoarbitragem ainda pendente'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.field_reviews fr
    WHERE (fr.self_verdict IS NULL) <> (fr.self_reviewed_at IS NULL)
      OR (fr.blind_verdict IS NULL) <> (fr.blind_decided_at IS NULL)
      OR (fr.final_verdict IS NULL) <> (fr.final_decided_at IS NULL)
      OR (
        fr.arbitrator_id IS NOT NULL
        AND fr.self_verdict IS DISTINCT FROM 'contesta_llm'
      )
      OR (
        fr.blind_verdict IS NOT NULL
        AND (
          fr.self_verdict IS DISTINCT FROM 'contesta_llm'
          OR fr.arbitrator_id IS NULL
        )
      )
      OR (
        fr.final_verdict IS NOT NULL
        AND (
          fr.self_verdict IS DISTINCT FROM 'contesta_llm'
          OR fr.arbitrator_id IS NULL
          OR fr.blind_verdict IS NULL
        )
      )
      OR (
        fr.final_verdict = 'llm'
        AND NULLIF(pg_catalog.btrim(fr.question_improvement_suggestion), '')
          IS NULL
      )
  ) THEN
    RAISE EXCEPTION
      'field_reviews contém combinação inválida de fase, ator ou timestamp'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.member_email_links mel
    JOIN public.project_members pm
      ON pm.project_id = mel.project_id
     AND pm.user_id = mel.linked_user_id
    WHERE mel.linked_user_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'uma conta vinculada também aparece como project_member no mesmo projeto'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER TABLE public.member_email_links
  DROP CONSTRAINT IF EXISTS member_email_links_member_user_id_fkey,
  ADD CONSTRAINT member_email_links_email_canonical_check
  CHECK (
    email <> ''
    AND email = pg_catalog.lower(pg_catalog.btrim(email))
  ),
  ADD CONSTRAINT member_email_links_distinct_alias_check
  CHECK (linked_user_id IS NULL OR linked_user_id <> member_user_id),
  ADD CONSTRAINT member_email_links_project_member_fkey
  FOREIGN KEY (project_id, member_user_id)
  REFERENCES public.project_members(project_id, user_id)
  ON DELETE CASCADE;

-- A FK composta passa a ser a única responsável por remover aliases do membro.
-- A RPC só limpa assignments pendentes explicitamente; duplicar o DELETE de
-- member_email_links esconderia o contrato de ciclo de vida declarado na FK.
CREATE OR REPLACE FUNCTION public.remove_project_member(
  p_member_id uuid
) RETURNS TABLE(project_id uuid)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH removed AS (
    DELETE FROM public.project_members AS pm
    WHERE pm.id = p_member_id
    RETURNING pm.project_id, pm.user_id
  ),
  deleted_assignments AS (
    DELETE FROM public.assignments AS assignment
    USING removed
    WHERE assignment.project_id = removed.project_id
      AND assignment.user_id = removed.user_id
      AND assignment.status = 'pendente'
    RETURNING assignment.id
  )
  SELECT removed.project_id
  FROM removed
$$;

-- linked_user_id é o primeiro campo porque todas as resoluções partem da
-- conta autenticada. Vários e-mails da mesma conta podem apontar para o mesmo
-- membro; o trigger serializado abaixo rejeita apenas targets distintos.
CREATE INDEX IF NOT EXISTS member_email_links_linked_user_project_idx
  ON public.member_email_links (linked_user_id, project_id)
  WHERE linked_user_id IS NOT NULL;

-- O índice antigo (linked_user_id sozinho) vira prefixo redundante do novo.
DROP INDEX IF EXISTS public.idx_member_email_links_linked_user;

-- Histórico concluído pode convergir para a mesma identidade após uma
-- unificação. Enquanto a arbitragem está aberta, porém, autor e árbitro devem
-- ser pessoas distintas.
ALTER TABLE public.field_reviews
  ADD CONSTRAINT field_reviews_pending_distinct_actors_check
  CHECK (
    final_verdict IS NOT NULL
    OR arbitrator_id IS NULL
    OR arbitrator_id <> self_reviewer_id
  ),
  ADD CONSTRAINT field_reviews_self_phase_timestamp_check
  CHECK ((self_verdict IS NULL) = (self_reviewed_at IS NULL)),
  ADD CONSTRAINT field_reviews_blind_phase_timestamp_check
  CHECK ((blind_verdict IS NULL) = (blind_decided_at IS NULL)),
  ADD CONSTRAINT field_reviews_final_phase_timestamp_check
  CHECK ((final_verdict IS NULL) = (final_decided_at IS NULL)),
  ADD CONSTRAINT field_reviews_arbitration_phase_check
  CHECK (
    (
      arbitrator_id IS NULL
      OR self_verdict IS NOT DISTINCT FROM 'contesta_llm'
    )
    AND (
      blind_verdict IS NULL
      OR (
        self_verdict IS NOT DISTINCT FROM 'contesta_llm'
        AND arbitrator_id IS NOT NULL
      )
    )
    AND (
      final_verdict IS NULL
      OR (
        self_verdict IS NOT DISTINCT FROM 'contesta_llm'
        AND arbitrator_id IS NOT NULL
        AND blind_verdict IS NOT NULL
      )
    )
    AND (
      final_verdict IS DISTINCT FROM 'llm'
      OR NULLIF(
        pg_catalog.btrim(question_improvement_suggestion),
        ''
      ) IS NOT NULL
    )
  );

-- Cada field_review produz no máximo um comentário automático: ambiguidades
-- terminam na auto-revisão, enquanto contestações só comentam se o árbitro
-- mantiver a resposta da LLM. Comentários manuais e o histórico deixam a
-- origem NULL. A FK torna a proveniência representável sem prefixos de texto.
--
-- ON DELETE anula somente a coluna de origem (forma com lista de colunas do
-- PG 15+, porque a FK composta inclui colunas NOT NULL): apagar a revisão não
-- pode apagar o comentário, já que respostas humanas penduradas nele via
-- parent_id (ON DELETE CASCADE em 20260406000000) morreriam junto — a
-- regeneração do backlog apaga field_reviews pendentes e destruiria threads de
-- discussão inteiras. O comentário sobrevive como comentário comum, sem
-- proveniência.
ALTER TABLE public.project_comments
  ADD COLUMN source_field_review_id UUID;

ALTER TABLE public.field_reviews
  ADD CONSTRAINT field_reviews_comment_source_key
  UNIQUE (id, project_id, document_id, field_name);

ALTER TABLE public.project_comments
  ADD CONSTRAINT project_comments_source_field_review_id_fkey
  FOREIGN KEY (source_field_review_id, project_id, document_id, field_name)
  REFERENCES public.field_reviews(id, project_id, document_id, field_name)
  ON DELETE SET NULL (source_field_review_id),
  ADD CONSTRAINT project_comments_source_field_review_context_check
  CHECK (
    source_field_review_id IS NULL
    OR (document_id IS NOT NULL AND field_name IS NOT NULL)
  ),
  ADD CONSTRAINT project_comments_source_field_review_id_key
  UNIQUE (source_field_review_id);

-- A origem identifica efeitos automáticos e não faz parte do contrato REST de
-- comentários. Mesmo autores, coordenadores e masters autenticados não podem
-- reservar nem alterar a proveniência; somente operações internas sem Clerk
-- JWT podem preenchê-la. A policy de INSERT abaixo exige NULL no mesmo sentido.
CREATE OR REPLACE FUNCTION public.enforce_project_comment_source_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF public.clerk_uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- O SET NULL referencial da FK de origem e o detach disparado pelo trigger
  -- de documents executam este trigger em profundidade aninhada (as ações
  -- referenciais rodam como triggers internos). O guard mira somente escrita
  -- direta pela API: em profundidade > 1 a mudança veio de mecânica interna do
  -- banco, não de um cliente, mesmo com JWT de sessão presente.
  IF pg_catalog.pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  -- OLD não existe no INSERT, então os dois eventos não podem compartilhar a
  -- mesma comparação: no INSERT qualquer valor não nulo já é reserva indevida.
  IF TG_OP = 'INSERT' THEN
    IF NEW.source_field_review_id IS NOT NULL THEN
      RAISE EXCEPTION
        'source_field_review_id is reserved for automatic project comments'
        USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.source_field_review_id
          IS DISTINCT FROM OLD.source_field_review_id
  THEN
    RAISE EXCEPTION
      'source_field_review_id is reserved for automatic project comments'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_project_comment_source_guard()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS enforce_project_comment_source_guard_trigger
  ON public.project_comments;
CREATE TRIGGER enforce_project_comment_source_guard_trigger
  BEFORE INSERT OR UPDATE OF source_field_review_id
  ON public.project_comments
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_project_comment_source_guard();

-- O FK histórico de project_comments.document_id preserva comentários manuais
-- com ON DELETE SET NULL. O CHECK de contexto exige documento e campo enquanto
-- a origem estiver preenchida, e a ordem entre as duas ações referenciais
-- (anular document_id vs. anular source_field_review_id via cascata de
-- field_reviews) não é garantida — se document_id anular primeiro, o CHECK
-- falha. Desanexar a proveniência antes das ações referenciais elimina a
-- corrida e dá aos comentários automáticos o mesmo ciclo de vida dos manuais:
-- a thread sobrevive à exclusão do documento.
CREATE OR REPLACE FUNCTION public.detach_automatic_comments_before_document()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.project_comments AS comment
  SET source_field_review_id = NULL
  WHERE comment.document_id = OLD.id
    AND comment.source_field_review_id IS NOT NULL;

  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.detach_automatic_comments_before_document()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS detach_automatic_comments_before_document_trigger
  ON public.documents;
CREATE TRIGGER detach_automatic_comments_before_document_trigger
  BEFORE DELETE ON public.documents
  FOR EACH ROW
  EXECUTE FUNCTION public.detach_automatic_comments_before_document();

-- Gestão de aliases é rara e globalmente serializada. O trigger por statement
-- toma a trava antes que UPDATE bloqueie qualquer linha; o trigger por linha
-- fica responsável apenas pelas invariantes. Essa ordem evita deadlock com a
-- unificação, que toma a mesma trava antes de tocar memberships ou aliases.
CREATE OR REPLACE FUNCTION public.lock_project_identity_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('canonical-project-identity', 0)
  );
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.lock_project_identity_changes()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS lock_member_email_links_identity_changes_trigger
  ON public.member_email_links;
CREATE TRIGGER lock_member_email_links_identity_changes_trigger
  BEFORE INSERT OR UPDATE ON public.member_email_links
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.lock_project_identity_changes();

CREATE OR REPLACE FUNCTION public.enforce_terminal_member_email_alias()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.linked_user_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.member_email_links mel
    WHERE mel.project_id = NEW.project_id
      AND mel.id IS DISTINCT FROM NEW.id
      AND mel.linked_user_id = NEW.linked_user_id
      AND mel.member_user_id <> NEW.member_user_id
  ) THEN
    RAISE EXCEPTION
      'uma conta não pode resolver para membros canônicos distintos no mesmo projeto'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.member_email_links mel
    WHERE mel.project_id = NEW.project_id
      AND mel.id IS DISTINCT FROM NEW.id
      AND mel.linked_user_id = NEW.member_user_id
  ) OR (
    NEW.linked_user_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.member_email_links mel
      WHERE mel.project_id = NEW.project_id
        AND mel.id IS DISTINCT FROM NEW.id
        AND mel.member_user_id = NEW.linked_user_id
    )
  ) THEN
    RAISE EXCEPTION
      'uma identidade não pode ser alias e membro canônico no mesmo projeto'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.linked_user_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.project_members pm
    WHERE pm.project_id = NEW.project_id
      AND pm.user_id = NEW.linked_user_id
  ) THEN
    RAISE EXCEPTION
      'uma conta vinculada não pode manter membership própria no projeto'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_terminal_member_email_alias()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS enforce_terminal_member_email_alias_trigger
  ON public.member_email_links;
CREATE TRIGGER enforce_terminal_member_email_alias_trigger
  BEFORE INSERT OR UPDATE ON public.member_email_links
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_terminal_member_email_alias();

-- Normalização canônica da lista de e-mails verificados de um snapshot Clerk.
-- Fonte única entre a fase 1 (begin, revogações) e a reconciliação (complete,
-- concessões): as duas precisam enxergar exatamente o mesmo conjunto, senão um
-- e-mail com caixa/espaço divergente seria revogado numa fase e não concedido
-- na outra.
CREATE OR REPLACE FUNCTION public.normalized_verified_emails(
  p_verified_emails TEXT[]
) RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT COALESCE(
    array_agg(DISTINCT pg_catalog.lower(pg_catalog.btrim(email))),
    ARRAY[]::TEXT[]
  )
  FROM unnest(p_verified_emails) AS verified(email)
  WHERE pg_catalog.btrim(email) <> '';
$$;

REVOKE ALL ON FUNCTION public.normalized_verified_emails(TEXT[])
  FROM PUBLIC, anon, authenticated, service_role;

-- Reconcilia a lista completa de e-mails verificados de uma conta numa única
-- transação. Links removidos no Clerk perdem o acesso primeiro. Links
-- redundantes para a própria membership são apagados, e projetos em que a
-- conta já é membro ou em que seus e-mails apontam para targets distintos
-- permanecem sem alias até uma unificação explícita do coordenador.
CREATE OR REPLACE FUNCTION public.reconcile_member_email_links(
  p_linked_user_id UUID,
  p_verified_emails TEXT[]
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_verified_emails TEXT[] :=
    public.normalized_verified_emails(p_verified_emails);
  v_conflict_projects UUID[];
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('canonical-project-identity', 0)
  );

  -- Posse removida no Clerk revoga acesso, mas preserva o pré-registro para
  -- que um dono futuro do endereço possa resolvê-lo novamente.
  UPDATE public.member_email_links
  SET linked_user_id = NULL
  WHERE linked_user_id = p_linked_user_id
    AND NOT (email = ANY(v_verified_emails));

  -- A conta já exerce diretamente esta identidade; manter um alias self seria
  -- redundante e violaria a representação terminal.
  DELETE FROM public.member_email_links
  WHERE member_user_id = p_linked_user_id
    AND email = ANY(v_verified_emails);

  SELECT COALESCE(array_agg(conflict.project_id), ARRAY[]::UUID[])
  INTO v_conflict_projects
  FROM (
    SELECT mel.project_id
    FROM public.member_email_links mel
    WHERE mel.email = ANY(v_verified_emails)
    GROUP BY mel.project_id
    HAVING count(DISTINCT mel.member_user_id) > 1

    UNION

    SELECT mel.project_id
    FROM public.member_email_links mel
    JOIN public.project_members pm
      ON pm.project_id = mel.project_id
     AND pm.user_id = p_linked_user_id
    WHERE mel.email = ANY(v_verified_emails)
  ) conflict;

  -- Uma conta não pode conservar um target arbitrário enquanto a posse atual
  -- de seus e-mails produz mais de uma identidade possível no projeto.
  UPDATE public.member_email_links
  SET linked_user_id = NULL
  WHERE email = ANY(v_verified_emails)
    AND project_id = ANY(v_conflict_projects);

  UPDATE public.member_email_links
  SET linked_user_id = p_linked_user_id
  WHERE email = ANY(v_verified_emails)
    AND linked_user_id IS DISTINCT FROM p_linked_user_id
    AND NOT (project_id = ANY(v_conflict_projects));
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_member_email_links(UUID, TEXT[])
  FROM PUBLIC, anon, authenticated, service_role;

-- A primeira fase escolhe a geração e derruba o marker numa transação própria.
-- Se a segunda fase falhar, este estado 0 já está commitado e tokens do snapshot
-- anterior permanecem rejeitados até um retry concluir os efeitos.
--
-- As revogações de alias por posse de e-mail também moram aqui, e não na
-- reconciliação da fase 2: quando um e-mail migra de conta e o snapshot do
-- novo dono nunca conclui a segunda fase (superseded, clerk_deleted, falha), o
-- dono anterior conservaria um link resolvendo para a identidade do membro.
-- Fase 1 revoga, fase 2 concede — o pior caso vira alias sem resolução
-- (fail-closed), nunca acesso residual.
CREATE OR REPLACE FUNCTION public.begin_clerk_access_snapshot(
  p_clerk_user_id TEXT,
  p_supabase_user_id UUID,
  p_snapshot_version BIGINT,
  p_verified_emails TEXT[]
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_current_snapshot_version BIGINT;
  v_clerk_deleted BOOLEAN;
  v_access_sync_version INTEGER;
  v_verified_emails TEXT[] :=
    public.normalized_verified_emails(p_verified_emails);
BEGIN
  IF p_snapshot_version < 0 THEN
    RAISE EXCEPTION 'snapshot Clerk inválido' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('canonical-project-identity', 0)
  );

  SELECT
    mapping.access_snapshot_version,
    mapping.clerk_deleted,
    mapping.access_sync_version
  INTO
    v_current_snapshot_version,
    v_clerk_deleted,
    v_access_sync_version
  FROM public.clerk_user_mapping mapping
  WHERE mapping.clerk_user_id = p_clerk_user_id
    AND mapping.supabase_user_id = p_supabase_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'mapping Clerk-Supabase inexistente'
      USING ERRCODE = '23503';
  END IF;

  IF v_clerk_deleted OR v_current_snapshot_version > p_snapshot_version THEN
    RETURN false;
  END IF;

  -- Replay da geração já concluída é no-op DE SUCESSO, não recomeço nem
  -- conflito. A versão vem do `updatedAt` do Clerk e o Svix entrega
  -- at-least-once, então a mesma versão chega mais de uma vez. Duas proteções
  -- compostas: (1) o marker NÃO cai para 0 — sem isso a reentrega revogava o
  -- acesso de conta já sincronizada até a fase 2 refazer a concessão; (2) o
  -- retorno segue TRUE — devolver false aqui classificava o estado convergido
  -- (o estado normal de toda conta estável) como "superseded" nos callers,
  -- fazendo addMember/linkMemberEmail/unifyMembers falharem para sempre,
  -- o webhook responder 500 em loop de reentrega e o reparo de metadata
  -- (que vive depois da fase 2 no caller) ficar inalcançável. A fase 2 é
  -- idempotente sobre a mesma geração, então seguir adiante sem resetar o
  -- marker é seguro; a revogação por posse abaixo também é idempotente e
  -- ainda roda, corrigindo drift de links antes da fase 2.
  IF NOT (
    v_current_snapshot_version = p_snapshot_version
    AND v_access_sync_version >= 1
  ) THEN
    UPDATE public.clerk_user_mapping
    SET access_sync_version = 0,
        access_snapshot_version = p_snapshot_version
    WHERE clerk_user_id = p_clerk_user_id
      AND supabase_user_id = p_supabase_user_id;
  END IF;

  -- Revogação por posse, já na geração escolhida: e-mails deste snapshot
  -- deixam de resolver para qualquer outra conta, e os links desta conta para
  -- e-mails que saíram caem juntos. A reconciliação da fase 2 refaz ambos de
  -- forma idempotente antes de conceder; este passo só garante que a concessão
  -- pendente nunca deixe um dono anterior com acesso residual.
  UPDATE public.member_email_links
  SET linked_user_id = NULL
  WHERE (
      email = ANY(v_verified_emails)
      AND linked_user_id IS NOT NULL
      AND linked_user_id <> p_supabase_user_id
    )
    OR (
      linked_user_id = p_supabase_user_id
      AND NOT (email = ANY(v_verified_emails))
    );

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.begin_clerk_access_snapshot(
  TEXT, UUID, BIGINT, TEXT[]
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_clerk_access_snapshot(
  TEXT, UUID, BIGINT, TEXT[]
) TO service_role;

-- A segunda fase só toca a geração ainda escolhida pela primeira. Profile,
-- aliases e marker 1 são atômicos entre si; se falharem, o marker 0 da chamada
-- anterior não participa do rollback desta transação.
CREATE OR REPLACE FUNCTION public.complete_clerk_access_snapshot(
  p_clerk_user_id TEXT,
  p_supabase_user_id UUID,
  p_snapshot_version BIGINT,
  p_verified_emails TEXT[],
  p_first_name TEXT,
  p_last_name TEXT,
  p_activate BOOLEAN
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_current_snapshot_version BIGINT;
  v_clerk_deleted BOOLEAN;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('canonical-project-identity', 0)
  );

  SELECT mapping.access_snapshot_version, mapping.clerk_deleted
  INTO v_current_snapshot_version, v_clerk_deleted
  FROM public.clerk_user_mapping mapping
  WHERE mapping.clerk_user_id = p_clerk_user_id
    AND mapping.supabase_user_id = p_supabase_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'mapping Clerk-Supabase inexistente'
      USING ERRCODE = '23503';
  END IF;

  IF v_clerk_deleted OR v_current_snapshot_version <> p_snapshot_version THEN
    RETURN false;
  END IF;

  IF p_activate THEN
    UPDATE public.profiles AS profile
    SET first_name = p_first_name,
        last_name = p_last_name,
        activated_at = COALESCE(
          profile.activated_at,
          pg_catalog.statement_timestamp()
        )
    WHERE profile.id = p_supabase_user_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'profile Supabase inexistente'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  PERFORM public.reconcile_member_email_links(
    p_supabase_user_id,
    p_verified_emails
  );

  IF p_activate THEN
    UPDATE public.clerk_user_mapping
    SET access_sync_version = 1
    WHERE clerk_user_id = p_clerk_user_id
      AND supabase_user_id = p_supabase_user_id
      AND access_snapshot_version = p_snapshot_version
      AND NOT clerk_deleted;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'mapping Clerk-Supabase mudou durante a reconciliação'
        USING ERRCODE = '40001';
    END IF;
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_clerk_access_snapshot(
  TEXT, UUID, BIGINT, TEXT[], TEXT, TEXT, BOOLEAN
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_clerk_access_snapshot(
  TEXT, UUID, BIGINT, TEXT[], TEXT, TEXT, BOOLEAN
) TO service_role;

-- Exclusão da conta é terminal para o Clerk ID. A mesma trava garante que uma
-- reconciliação já em voo termine antes da revogação, ou observe clerk_deleted
-- e não aplique o snapshot antigo depois dela.
CREATE OR REPLACE FUNCTION public.begin_clerk_user_revocation(
  p_clerk_user_id TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_supabase_user_id UUID;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('canonical-project-identity', 0)
  );

  SELECT mapping.supabase_user_id
  INTO v_supabase_user_id
  FROM public.clerk_user_mapping mapping
  WHERE mapping.clerk_user_id = p_clerk_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE public.clerk_user_mapping
  SET access_sync_version = 0,
      clerk_deleted = true
  WHERE clerk_user_id = p_clerk_user_id;

  RETURN v_supabase_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.begin_clerk_user_revocation(TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_clerk_user_revocation(TEXT)
  TO service_role;

CREATE OR REPLACE FUNCTION public.complete_clerk_user_revocation(
  p_clerk_user_id TEXT,
  p_supabase_user_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('canonical-project-identity', 0)
  );

  PERFORM 1
  FROM public.clerk_user_mapping mapping
  WHERE mapping.clerk_user_id = p_clerk_user_id
    AND mapping.supabase_user_id = p_supabase_user_id
    AND mapping.clerk_deleted
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  PERFORM public.reconcile_member_email_links(
    p_supabase_user_id,
    ARRAY[]::TEXT[]
  );
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_clerk_user_revocation(TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_clerk_user_revocation(TEXT, UUID)
  TO service_role;

-- O sentido inverso usa a mesma trava global: uma conta já vinculada não
-- pode voltar a ser inserida como membership bruta. As chaves da membership
-- são imutáveis; updates de papel/flags não passam por este trigger.
CREATE OR REPLACE FUNCTION public.enforce_terminal_project_membership()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.project_id IS DISTINCT FROM NEW.project_id
       OR OLD.user_id IS DISTINCT FROM NEW.user_id
    THEN
      RAISE EXCEPTION 'project_id e user_id de uma membership são imutáveis'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.member_email_links mel
    WHERE mel.project_id = NEW.project_id
      AND mel.linked_user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION
      'uma conta vinculada não pode receber membership própria no projeto'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_terminal_project_membership()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS lock_project_members_identity_changes_trigger
  ON public.project_members;
CREATE TRIGGER lock_project_members_identity_changes_trigger
  BEFORE INSERT ON public.project_members
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.lock_project_identity_changes();

DROP TRIGGER IF EXISTS enforce_terminal_project_membership_insert_trigger
  ON public.project_members;
CREATE TRIGGER enforce_terminal_project_membership_insert_trigger
  BEFORE INSERT ON public.project_members
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_terminal_project_membership();

DROP TRIGGER IF EXISTS enforce_terminal_project_membership_update_trigger
  ON public.project_members;
CREATE TRIGGER enforce_terminal_project_membership_update_trigger
  BEFORE UPDATE OF project_id, user_id ON public.project_members
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_terminal_project_membership();

-- ========== 2. Funções de acesso com precedência canônica ==========
-- Relação canônica única: cada helper de projeto, papel e permissão deriva
-- desta mesma membership terminal, sem repetir o UNION raw-versus-alias.
--
-- Custo importa: clerk_uid() deixou de ser extração de claim e passou a
-- consultar clerk_user_mapping, então o CTE o computa uma única vez por
-- avaliação em vez de uma vez por braço. UNION ALL substitui UNION porque
-- enforce_terminal_project_membership garante que um mesmo projeto nunca
-- aparece nos dois braços (conta vinculada não recebe membership própria); o
-- DISTINCT do braço de alias cobre o único caso de duplicata restante, dois
-- e-mails da mesma conta apontando ao mesmo membro no mesmo projeto.
CREATE OR REPLACE FUNCTION public.auth_user_project_memberships()
RETURNS TABLE (
  project_id UUID,
  user_id UUID,
  role TEXT,
  can_arbitrate BOOLEAN,
  can_resolve BOOLEAN,
  can_compare BOOLEAN
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
ROWS 16
AS $$
  WITH session_account AS (
    SELECT public.clerk_uid() AS account_id
  )
  SELECT
    pm.project_id,
    pm.user_id,
    pm.role,
    pm.can_arbitrate,
    pm.can_resolve,
    pm.can_compare
  FROM session_account
  JOIN public.project_members pm
    ON pm.user_id = session_account.account_id
  UNION ALL
  SELECT DISTINCT
    pm.project_id,
    pm.user_id,
    pm.role,
    pm.can_arbitrate,
    pm.can_resolve,
    pm.can_compare
  FROM session_account
  JOIN public.member_email_links mel
    ON mel.linked_user_id = session_account.account_id
  JOIN public.project_members pm
    ON pm.project_id = mel.project_id
   AND pm.user_id = mel.member_user_id
$$;

-- As policies da seção 2b referenciam a relação canônica diretamente e
-- executam com o papel da sessão, então EXECUTE acompanha as demais helpers.
-- SECURITY DEFINER devolve apenas as memberships do próprio JWT — expor a
-- função não expõe nada além do que auth_user_project_ids() já expunha.
REVOKE ALL ON FUNCTION public.auth_user_project_memberships()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.auth_user_project_memberships()
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.auth_user_project_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT membership.project_id
  FROM public.auth_user_project_memberships() AS membership
$$;

CREATE OR REPLACE FUNCTION public.auth_user_coordinator_project_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT membership.project_id
  FROM public.auth_user_project_memberships() AS membership
  WHERE membership.role = 'coordenador'
$$;

-- Deriva direto de auth_user_project_memberships (uma camada a menos que via
-- auth_user_project_ids) e computa clerk_uid() uma vez para o braço de
-- criador. UNION com dedup fica: o criador costuma ser também membro.
CREATE OR REPLACE FUNCTION public.auth_user_accessible_project_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
ROWS 16
AS $$
  SELECT membership.project_id
  FROM public.auth_user_project_memberships() AS membership
  UNION
  SELECT p.id
  FROM (SELECT public.clerk_uid() AS account_id) AS session_account
  JOIN public.projects p
    ON p.created_by = session_account.account_id
$$;

CREATE OR REPLACE FUNCTION public.auth_user_coordinator_or_creator_project_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
ROWS 16
AS $$
  SELECT membership.project_id
  FROM public.auth_user_project_memberships() AS membership
  WHERE membership.role = 'coordenador'
  UNION
  SELECT p.id
  FROM (SELECT public.clerk_uid() AS account_id) AS session_account
  JOIN public.projects p
    ON p.created_by = session_account.account_id
$$;

CREATE OR REPLACE FUNCTION public.auth_user_resolver_project_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT membership.project_id
  FROM public.auth_user_project_memberships() AS membership
  WHERE membership.can_resolve
$$;

-- Uma conta só exerce identidade de trabalho onde a membership terminal
-- existe. Remover a membership revoga também mutations de linhas históricas;
-- o UUID bruto nunca é devolvido como fallback sem vínculo ao projeto.
CREATE OR REPLACE FUNCTION public.auth_user_member_identity_ids(
  p_project_id UUID
)
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT membership.user_id
  FROM public.auth_user_project_memberships() AS membership
  WHERE membership.project_id = p_project_id
$$;

GRANT EXECUTE ON FUNCTION public.auth_user_project_ids()
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.auth_user_coordinator_project_ids()
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.auth_user_accessible_project_ids()
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.auth_user_coordinator_or_creator_project_ids()
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.auth_user_resolver_project_ids()
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.auth_user_member_identity_ids(UUID)
  TO anon, authenticated, service_role;

-- ========== 2b. Policies de identidade sem correlação por linha ==========
-- `col IN (SELECT auth_user_member_identity_ids(project_id))` correlaciona a
-- subquery pelo project_id DA LINHA: o planner reexecuta o helper — e toda a
-- cadeia clerk_uid()→mapping→UNION — uma vez por linha varrida, não uma vez
-- por query. Com clerk_uid() consultando tabela, o bench local mediu ~9× de
-- regressão em `SELECT count(*) FROM responses` (153ms→1.341ms em 4k linhas).
-- A forma por tupla `(project_id, col) IN (SELECT project_id, user_id FROM
-- auth_user_project_memberships())` é semanticamente idêntica e
-- não-correlacionada: o helper roda uma vez e cada linha custa um probe de
-- hash. As policies abaixo vêm de 20260611130000/20260716154500 (já aplicadas
-- no remoto) e são recriadas nessa forma. Diferença deliberada de predicado:
-- o braço de escrita por uid cru (o helper antigo devolvia clerk_uid()
-- incondicionalmente) NÃO é recriado para contas-alias — essa é a correção do
-- #416 —, mas o master mantém um braço explícito para a própria resposta em
-- responses (abaixo) e para researcher_field_orders (seção própria).
DROP POLICY IF EXISTS "Users manage own responses" ON public.responses;
CREATE POLICY "Users manage own responses" ON public.responses
  FOR ALL
  USING (
    (project_id, respondent_id) IN (
      SELECT membership.project_id, membership.user_id
      FROM public.auth_user_project_memberships() AS membership
    )
    OR project_id IN (
      SELECT public.auth_user_coordinator_or_creator_project_ids()
    )
    OR (SELECT public.is_master())
  )
  WITH CHECK (
    respondent_type = 'humano'
    AND (
      (
        (project_id, respondent_id) IN (
          SELECT membership.project_id, membership.user_id
          FROM public.auth_user_project_memberships() AS membership
        )
        AND (
          project_id IN (SELECT public.auth_user_accessible_project_ids())
          OR (SELECT public.is_master())
        )
      )
      -- Braço de escape do master, espelhando researcher_field_orders: um
      -- master sem linha em project_members ainda grava a PRÓPRIA resposta
      -- humana (a base permitia via uid cru no helper de identidades; o gate
      -- de tupla sozinho tornava o is_master() acima letra morta e o submit
      -- da codificação falhava com 42501). Restrito ao clerk_uid() do próprio
      -- master — nunca reabre a escrita por uid cru de conta-alias, que é a
      -- família de bug (#416) que esta migration fecha.
      OR (
        (SELECT public.is_master())
        AND respondent_id = (SELECT public.clerk_uid())
      )
    )
  );

DROP POLICY IF EXISTS "Reviewers manage reviews" ON public.reviews;
CREATE POLICY "Reviewers manage reviews" ON public.reviews
  FOR ALL
  USING (
    (project_id, reviewer_id) IN (
      SELECT membership.project_id, membership.user_id
      FROM public.auth_user_project_memberships() AS membership
    )
    OR project_id IN (
      SELECT public.auth_user_coordinator_or_creator_project_ids()
    )
    OR (SELECT public.is_master())
  );

DROP POLICY IF EXISTS "Members view own field_reviews" ON public.field_reviews;
CREATE POLICY "Members view own field_reviews" ON public.field_reviews
  FOR SELECT
  USING (
    (SELECT public.is_master())
    OR project_id IN (
      SELECT public.auth_user_coordinator_or_creator_project_ids()
    )
    OR (
      project_id IN (SELECT public.auth_user_accessible_project_ids())
      AND (
        (project_id, self_reviewer_id) IN (
          SELECT membership.project_id, membership.user_id
          FROM public.auth_user_project_memberships() AS membership
        )
        OR (project_id, arbitrator_id) IN (
          SELECT membership.project_id, membership.user_id
          FROM public.auth_user_project_memberships() AS membership
        )
      )
    )
  );

DROP POLICY IF EXISTS "Self reviewer updates own row" ON public.field_reviews;
CREATE POLICY "Self reviewer updates own row" ON public.field_reviews
  FOR UPDATE
  USING (
    (project_id, self_reviewer_id) IN (
      SELECT membership.project_id, membership.user_id
      FROM public.auth_user_project_memberships() AS membership
    )
  )
  WITH CHECK (
    (project_id, self_reviewer_id) IN (
      SELECT membership.project_id, membership.user_id
      FROM public.auth_user_project_memberships() AS membership
    )
  );

DROP POLICY IF EXISTS "Arbitrator updates own row" ON public.field_reviews;
CREATE POLICY "Arbitrator updates own row" ON public.field_reviews
  FOR UPDATE
  USING (
    (project_id, arbitrator_id) IN (
      SELECT membership.project_id, membership.user_id
      FROM public.auth_user_project_memberships() AS membership
    )
  )
  WITH CHECK (
    (project_id, arbitrator_id) IN (
      SELECT membership.project_id, membership.user_id
      FROM public.auth_user_project_memberships() AS membership
    )
  );

-- RLS identifica quem pode tocar a linha; este trigger limita o que cada ator
-- pode mudar. Sem a guarda de colunas, self-reviewer e árbitro poderiam manter
-- o próprio id e gravar diretamente as fases um do outro pela API REST.
CREATE OR REPLACE FUNCTION public.enforce_field_review_phase_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_is_self_reviewer BOOLEAN;
  v_is_arbitrator BOOLEAN;
  v_is_coordinator BOOLEAN;
BEGIN
  -- Escritas estruturais usam o cliente administrativo. A autorização desse
  -- papel não depende dos claims que possam ter ficado no contexto da sessão;
  -- as transições feitas pelo usuário continuam passando pelo papel
  -- authenticated e pelas guardas abaixo.
  -- A função é SECURITY DEFINER, portanto current_user é seu proprietário;
  -- o papel efetivo do request permanece exposto pelo parâmetro `role`.
  IF pg_catalog.current_setting('role', true) = 'service_role'
     OR public.clerk_uid() IS NULL
  THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.auth_user_member_identity_ids(OLD.project_id)
      AS identity(user_id)
    WHERE identity.user_id = OLD.self_reviewer_id
  ) INTO v_is_self_reviewer;

  SELECT EXISTS (
    SELECT 1
    FROM public.auth_user_member_identity_ids(OLD.project_id)
      AS identity(user_id)
    WHERE identity.user_id = OLD.arbitrator_id
  ) INTO v_is_arbitrator;

  SELECT public.is_master() OR EXISTS (
    SELECT 1
    FROM public.auth_user_coordinator_or_creator_project_ids()
      AS managed(project_id)
    WHERE managed.project_id = OLD.project_id
  ) INTO v_is_coordinator;

  -- Auto-revisão é uma transição única NULL→veredito e só pode tocar self_*.
  IF v_is_self_reviewer
     AND OLD.self_verdict IS NULL
     AND OLD.self_reviewed_at IS NULL
     AND NEW.self_verdict IS NOT NULL
     AND (
       (
         NEW.self_verdict IN ('contesta_llm', 'ambiguo')
         AND NULLIF(pg_catalog.btrim(NEW.self_justification), '') IS NOT NULL
       )
       OR (
         NEW.self_verdict NOT IN ('contesta_llm', 'ambiguo')
         AND NEW.self_justification IS NULL
       )
     )
     AND (
       to_jsonb(NEW) - ARRAY[
         'self_verdict',
         'self_justification',
         'self_reviewed_at',
         'changed_after_justification'
       ]
     ) IS NOT DISTINCT FROM (
       to_jsonb(OLD) - ARRAY[
         'self_verdict',
         'self_justification',
         'self_reviewed_at',
         'changed_after_justification'
       ]
     )
  THEN
    NEW.self_reviewed_at := pg_catalog.statement_timestamp();
    RETURN NEW;
  END IF;

  -- Primeira fase do árbitro: somente a decisão cega, sem antecipar a final.
  IF v_is_arbitrator
     AND OLD.self_verdict = 'contesta_llm'
     AND OLD.blind_verdict IS NULL
     AND OLD.blind_decided_at IS NULL
     AND OLD.final_verdict IS NULL
     AND NEW.blind_verdict IS NOT NULL
     AND (
       to_jsonb(NEW) - ARRAY[
         'blind_verdict',
         'blind_decided_at',
         'changed_after_justification'
       ]
     ) IS NOT DISTINCT FROM (
       to_jsonb(OLD) - ARRAY[
         'blind_verdict',
         'blind_decided_at',
         'changed_after_justification'
       ]
     )
  THEN
    NEW.blind_decided_at := pg_catalog.statement_timestamp();
    RETURN NEW;
  END IF;

  -- Segunda fase: blind_* e toda a identidade permanecem imutáveis.
  IF v_is_arbitrator
     AND OLD.self_verdict = 'contesta_llm'
     AND OLD.blind_verdict IS NOT NULL
     AND OLD.final_verdict IS NULL
     AND OLD.final_decided_at IS NULL
     AND NEW.final_verdict IS NOT NULL
     AND (
       NEW.final_verdict <> 'llm'
       OR NULLIF(
         pg_catalog.btrim(NEW.question_improvement_suggestion),
         ''
       ) IS NOT NULL
     )
     AND (
       to_jsonb(NEW) - ARRAY[
         'final_verdict',
         'final_decided_at',
         'question_improvement_suggestion',
         'arbitrator_comment',
         'changed_after_justification'
       ]
     ) IS NOT DISTINCT FROM (
       to_jsonb(OLD) - ARRAY[
         'final_verdict',
         'final_decided_at',
         'question_improvement_suggestion',
         'arbitrator_comment',
         'changed_after_justification'
       ]
     )
  THEN
    NEW.final_decided_at := pg_catalog.statement_timestamp();
    RETURN NEW;
  END IF;

  -- A RPC de desabilitação pode apenas devolver uma arbitragem aberta ao pool.
  IF v_is_coordinator
     AND OLD.final_verdict IS NULL
     AND NEW.arbitrator_id IS NULL
     AND NEW.blind_verdict IS NULL
     AND NEW.blind_decided_at IS NULL
     AND (
       to_jsonb(NEW) - ARRAY[
         'arbitrator_id',
         'blind_verdict',
         'blind_decided_at',
         'changed_after_justification'
       ]
     ) IS NOT DISTINCT FROM (
       to_jsonb(OLD) - ARRAY[
         'arbitrator_id',
         'blind_verdict',
         'blind_decided_at',
         'changed_after_justification'
       ]
     )
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'field_review phase transition is not allowed for this actor'
    USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_field_review_phase_transition()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS enforce_field_review_phase_transition_trigger
  ON public.field_reviews;
CREATE TRIGGER enforce_field_review_phase_transition_trigger
  BEFORE UPDATE ON public.field_reviews
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_field_review_phase_transition();

-- Escritas estruturais são internas (service role). Usuários autenticados só
-- atualizam a própria fase; coordenadores apenas liberam arbitragem via RPC.
DROP POLICY IF EXISTS "Coordinators manage field_reviews"
  ON public.field_reviews;
DROP POLICY IF EXISTS "Self reviewer inserts own row"
  ON public.field_reviews;

DROP POLICY IF EXISTS "Coordinators release field_reviews"
  ON public.field_reviews;
CREATE POLICY "Coordinators release field_reviews"
  ON public.field_reviews
  FOR UPDATE
  USING (
    project_id IN (
      SELECT managed.project_id
      FROM public.auth_user_coordinator_or_creator_project_ids()
        AS managed(project_id)
    )
    OR (SELECT public.is_master())
  )
  WITH CHECK (
    project_id IN (
      SELECT managed.project_id
      FROM public.auth_user_coordinator_or_creator_project_ids()
        AS managed(project_id)
    )
    OR (SELECT public.is_master())
  );

-- A RLS autoriza coordenadores a gerenciar memberships de terceiros. Este
-- guard separa essa autorização da autoalteração: cada conta tem uma única
-- identidade de membership por projeto, devolvida pelo helper canônico.
-- A função em si vem de 20260715095741_project_members_column_guard.sql e não
-- muda aqui; redefini-la só criaria uma segunda cópia da mesma regra para sair
-- do lugar sozinha. O que falta lá é fechar o EXECUTE.
REVOKE ALL ON FUNCTION public.enforce_project_members_column_guard()
  FROM PUBLIC, anon, authenticated, service_role;

-- ========== 3. Perfis dos membros de projetos acessíveis ==========
DROP POLICY IF EXISTS "Users and teammates view profiles" ON public.profiles;
DROP POLICY IF EXISTS "Project members view teammate profiles" ON public.profiles;
CREATE POLICY "Users and teammates view profiles" ON public.profiles
  FOR SELECT
  USING (
    id = (SELECT public.clerk_uid())
    OR (SELECT public.is_master())
    OR EXISTS (
      SELECT 1
      FROM public.project_members teammate
      WHERE teammate.user_id = profiles.id
        AND teammate.project_id IN (
          SELECT accessible.project_id
          FROM public.auth_user_accessible_project_ids()
            AS accessible(project_id)
        )
    )
    OR EXISTS (
      SELECT 1
      FROM public.member_email_links alias_account
      WHERE alias_account.linked_user_id = profiles.id
        AND alias_account.project_id IN (
          SELECT accessible.project_id
          FROM public.auth_user_accessible_project_ids()
            AS accessible(project_id)
        )
    )
  );

-- ========== 4. Vereditos e equivalências usam identidade canônica ==========
DROP POLICY IF EXISTS "Members can view acknowledgments"
  ON public.verdict_acknowledgments;
CREATE POLICY "Members can view acknowledgments"
  ON public.verdict_acknowledgments
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.reviews review
      WHERE review.id = verdict_acknowledgments.review_id
        AND review.project_id IN (
          SELECT accessible.project_id
          FROM public.auth_user_accessible_project_ids()
            AS accessible(project_id)
        )
    )
    OR (SELECT public.is_master())
  );

DROP POLICY IF EXISTS "Respondents can upsert own acknowledgments"
  ON public.verdict_acknowledgments;
CREATE POLICY "Respondents can upsert own acknowledgments"
  ON public.verdict_acknowledgments
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.reviews review
      WHERE review.id = verdict_acknowledgments.review_id
        AND verdict_acknowledgments.respondent_id IN (
          SELECT identity.user_id
          FROM public.auth_user_member_identity_ids(review.project_id)
            AS identity(user_id)
        )
    )
  );

DROP POLICY IF EXISTS "Respondents can update own acknowledgments"
  ON public.verdict_acknowledgments;
CREATE POLICY "Respondents can update own acknowledgments"
  ON public.verdict_acknowledgments
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM public.reviews review
      WHERE review.id = verdict_acknowledgments.review_id
        AND verdict_acknowledgments.respondent_id IN (
          SELECT identity.user_id
          FROM public.auth_user_member_identity_ids(review.project_id)
            AS identity(user_id)
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.reviews review
      WHERE review.id = verdict_acknowledgments.review_id
        AND verdict_acknowledgments.respondent_id IN (
          SELECT identity.user_id
          FROM public.auth_user_member_identity_ids(review.project_id)
            AS identity(user_id)
        )
    )
  );

DROP POLICY IF EXISTS "Coordinators can update verdict_acknowledgments"
  ON public.verdict_acknowledgments;
CREATE POLICY "Coordinators can update verdict_acknowledgments"
  ON public.verdict_acknowledgments
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM public.reviews review
      WHERE review.id = verdict_acknowledgments.review_id
        AND review.project_id IN (
          SELECT managed.project_id
          FROM public.auth_user_coordinator_or_creator_project_ids()
            AS managed(project_id)
        )
    )
    OR (SELECT public.is_master())
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.reviews review
      WHERE review.id = verdict_acknowledgments.review_id
        AND review.project_id IN (
          SELECT managed.project_id
          FROM public.auth_user_coordinator_or_creator_project_ids()
            AS managed(project_id)
        )
    )
    OR (SELECT public.is_master())
  );

DROP POLICY IF EXISTS "Members view response_equivalences"
  ON public.response_equivalences;
CREATE POLICY "Members view response_equivalences"
  ON public.response_equivalences
  FOR SELECT
  USING (
    project_id IN (
      SELECT accessible.project_id
      FROM public.auth_user_accessible_project_ids()
        AS accessible(project_id)
    )
    OR (SELECT public.is_master())
  );

DROP POLICY IF EXISTS "Reviewers manage response_equivalences"
  ON public.response_equivalences;
CREATE POLICY "Reviewers manage response_equivalences"
  ON public.response_equivalences
  FOR ALL
  USING (
    (project_id, reviewer_id) IN (
      SELECT membership.project_id, membership.user_id
      FROM public.auth_user_project_memberships() AS membership
    )
    OR project_id IN (
      SELECT managed.project_id
      FROM public.auth_user_coordinator_or_creator_project_ids()
        AS managed(project_id)
    )
    OR (SELECT public.is_master())
  )
  WITH CHECK (
    (project_id, reviewer_id) IN (
      SELECT membership.project_id, membership.user_id
      FROM public.auth_user_project_memberships() AS membership
    )
    OR project_id IN (
      SELECT managed.project_id
      FROM public.auth_user_coordinator_or_creator_project_ids()
        AS managed(project_id)
    )
    OR (SELECT public.is_master())
  );

DROP POLICY IF EXISTS "Users view own field order"
  ON public.researcher_field_orders;
CREATE POLICY "Users view own field order"
  ON public.researcher_field_orders
  FOR SELECT
  USING (
    (
      (project_id, user_id) IN (
        SELECT membership.project_id, membership.user_id
        FROM public.auth_user_project_memberships() AS membership
      )
      AND
      project_id IN (
        SELECT accessible.project_id
        FROM public.auth_user_accessible_project_ids()
          AS accessible(project_id)
      )
    )
    OR (
      (SELECT public.is_master())
      AND user_id = (SELECT public.clerk_uid())
    )
  );

DROP POLICY IF EXISTS "Users insert own field order"
  ON public.researcher_field_orders;
CREATE POLICY "Users insert own field order"
  ON public.researcher_field_orders
  FOR INSERT
  WITH CHECK (
    (
      (project_id, user_id) IN (
        SELECT membership.project_id, membership.user_id
        FROM public.auth_user_project_memberships() AS membership
      )
      AND
      project_id IN (
        SELECT accessible.project_id
        FROM public.auth_user_accessible_project_ids()
          AS accessible(project_id)
      )
    )
    OR (
      (SELECT public.is_master())
      AND user_id = (SELECT public.clerk_uid())
    )
  );

DROP POLICY IF EXISTS "Users update own field order"
  ON public.researcher_field_orders;
CREATE POLICY "Users update own field order"
  ON public.researcher_field_orders
  FOR UPDATE
  USING (
    (
      (project_id, user_id) IN (
        SELECT membership.project_id, membership.user_id
        FROM public.auth_user_project_memberships() AS membership
      )
      AND
      project_id IN (
        SELECT accessible.project_id
        FROM public.auth_user_accessible_project_ids()
          AS accessible(project_id)
      )
    )
    OR (
      (SELECT public.is_master())
      AND user_id = (SELECT public.clerk_uid())
    )
  )
  WITH CHECK (
    (
      (project_id, user_id) IN (
        SELECT membership.project_id, membership.user_id
        FROM public.auth_user_project_memberships() AS membership
      )
      AND
      project_id IN (
        SELECT accessible.project_id
        FROM public.auth_user_accessible_project_ids()
          AS accessible(project_id)
      )
    )
    OR (
      (SELECT public.is_master())
      AND user_id = (SELECT public.clerk_uid())
    )
  );

DROP POLICY IF EXISTS "Users delete own field order"
  ON public.researcher_field_orders;
CREATE POLICY "Users delete own field order"
  ON public.researcher_field_orders
  FOR DELETE
  USING (
    (
      (project_id, user_id) IN (
        SELECT membership.project_id, membership.user_id
        FROM public.auth_user_project_memberships() AS membership
      )
      AND
      project_id IN (
        SELECT accessible.project_id
        FROM public.auth_user_accessible_project_ids()
          AS accessible(project_id)
      )
    )
    OR (
      (SELECT public.is_master())
      AND user_id = (SELECT public.clerk_uid())
    )
  );

-- Policies antigas destas tabelas ainda consultavam project_members com o
-- id bruto, contornando os helpers canônicos. Autoria continua bruta.
DROP POLICY IF EXISTS "Members can view project comments"
  ON public.project_comments;
CREATE POLICY "Members can view project comments"
  ON public.project_comments
  FOR SELECT
  USING (
    project_id IN (
      SELECT accessible.project_id
      FROM public.auth_user_accessible_project_ids()
        AS accessible(project_id)
    )
    OR (SELECT public.is_master())
  );

DROP POLICY IF EXISTS "Members can create project comments"
  ON public.project_comments;
CREATE POLICY "Members can create project comments"
  ON public.project_comments
  FOR INSERT
  WITH CHECK (
    author_id = (SELECT public.clerk_uid())
    AND source_field_review_id IS NULL
    AND (
      project_id IN (
        SELECT accessible.project_id
        FROM public.auth_user_accessible_project_ids()
          AS accessible(project_id)
      )
      OR (SELECT public.is_master())
    )
  );

-- A policy efetiva desde 20260612090200 inclui membro, criador e master. O
-- helper de projetos acessíveis agora resolve também a membership canônica da
-- conta-alias sem regredir os outros dois braços.
DROP POLICY IF EXISTS "Members can delete ambiguity comments"
  ON public.project_comments;
CREATE POLICY "Members can delete ambiguity comments"
  ON public.project_comments
  FOR DELETE
  USING (
    kind = 'ambiguity'
    AND (
      project_id IN (
        SELECT accessible.project_id
        FROM public.auth_user_accessible_project_ids()
          AS accessible(project_id)
      )
      OR (SELECT public.is_master())
    )
  );

DROP POLICY IF EXISTS "Coordinators can update project comments"
  ON public.project_comments;
CREATE POLICY "Coordinators can update project comments"
  ON public.project_comments
  FOR UPDATE
  USING (
    project_id IN (
      SELECT managed.project_id
      FROM public.auth_user_coordinator_or_creator_project_ids()
        AS managed(project_id)
    )
    OR (SELECT public.is_master())
  )
  WITH CHECK (
    project_id IN (
      SELECT managed.project_id
      FROM public.auth_user_coordinator_or_creator_project_ids()
        AS managed(project_id)
    )
    OR (SELECT public.is_master())
  );

DROP POLICY IF EXISTS "Members can view suggestions"
  ON public.schema_suggestions;
CREATE POLICY "Members can view suggestions"
  ON public.schema_suggestions
  FOR SELECT
  USING (
    project_id IN (
      SELECT accessible.project_id
      FROM public.auth_user_accessible_project_ids()
        AS accessible(project_id)
    )
    OR (SELECT public.is_master())
  );

DROP POLICY IF EXISTS "Members can create suggestions"
  ON public.schema_suggestions;
CREATE POLICY "Members can create suggestions"
  ON public.schema_suggestions
  FOR INSERT
  WITH CHECK (
    suggested_by = (SELECT public.clerk_uid())
    AND (
      project_id IN (
        SELECT accessible.project_id
        FROM public.auth_user_accessible_project_ids()
          AS accessible(project_id)
      )
      OR (SELECT public.is_master())
    )
  );

DROP POLICY IF EXISTS "Coordinators can update suggestions"
  ON public.schema_suggestions;
CREATE POLICY "Coordinators can update suggestions"
  ON public.schema_suggestions
  FOR UPDATE
  USING (
    project_id IN (
      SELECT managed.project_id
      FROM public.auth_user_coordinator_or_creator_project_ids()
        AS managed(project_id)
    )
    OR (SELECT public.is_master())
  )
  WITH CHECK (
    project_id IN (
      SELECT managed.project_id
      FROM public.auth_user_coordinator_or_creator_project_ids()
        AS managed(project_id)
    )
    OR (SELECT public.is_master())
  );

-- ========== 5. Unificação compatível com a identidade única ==========
-- Preview e execução compartilham estas contagens. A UI não baixa respostas,
-- revisões ou assignments sem limite; a RPC devolve somente cinco agregados.
CREATE OR REPLACE FUNCTION public.preview_project_member_unification(
  p_project_id UUID,
  p_source_user_id UUID,
  p_target_user_id UUID
) RETURNS TABLE (
  assignments_to_migrate BIGINT,
  docs_with_both_responses BIGINT,
  review_conflicts BIGINT,
  arbitration_conflicts BIGINT,
  comparison_conflicts BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
BEGIN
  IF p_source_user_id = p_target_user_id THEN
    RAISE EXCEPTION 'source e target devem ser membros distintos';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.project_members pm
    WHERE pm.project_id = p_project_id
      AND pm.user_id = p_target_user_id
  ) THEN
    RAISE EXCEPTION 'target deve ser membro do projeto';
  END IF;

  -- Ausência do source significa que a conta pode ser vinculada como alias,
  -- sem unificação. A action distingue esse caso por uma resposta sem linha.
  IF NOT EXISTS (
    SELECT 1
    FROM public.project_members pm
    WHERE pm.project_id = p_project_id
      AND pm.user_id = p_source_user_id
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    (
      SELECT count(*)
      FROM public.assignments assignment
      WHERE assignment.project_id = p_project_id
        AND assignment.user_id = p_source_user_id
    ),
    (
      SELECT count(*)
      FROM (
        SELECT response.document_id
        FROM public.responses response
        WHERE response.project_id = p_project_id
          AND response.respondent_type = 'humano'
          AND response.is_latest
          AND response.respondent_id IN (
            p_source_user_id,
            p_target_user_id
          )
        GROUP BY response.document_id
        HAVING count(DISTINCT response.respondent_id) = 2
      ) both_responses
    ),
    (
      SELECT count(*)
      FROM public.reviews source_review
      JOIN public.reviews target_review
        ON target_review.project_id = source_review.project_id
       AND target_review.document_id = source_review.document_id
       AND target_review.field_name = source_review.field_name
       AND target_review.reviewer_id = p_target_user_id
      WHERE source_review.project_id = p_project_id
        AND source_review.reviewer_id = p_source_user_id
    ),
    (
      SELECT count(*)
      FROM public.field_reviews field_review
      WHERE field_review.project_id = p_project_id
        AND field_review.final_verdict IS NULL
        AND (
          (
            field_review.self_reviewer_id = p_source_user_id
            AND field_review.arbitrator_id = p_target_user_id
          )
          OR (
            field_review.self_reviewer_id = p_target_user_id
            AND field_review.arbitrator_id = p_source_user_id
          )
        )
    ),
    (
      SELECT count(DISTINCT assignment.document_id)
      FROM public.assignments assignment
      JOIN public.responses response
        ON response.project_id = assignment.project_id
       AND response.document_id = assignment.document_id
       AND response.respondent_type = 'humano'
       AND response.is_latest
      WHERE assignment.project_id = p_project_id
        AND assignment.type = 'comparacao'
        AND assignment.status IS DISTINCT FROM 'concluido'
        AND (
          (
            assignment.user_id = p_source_user_id
            AND response.respondent_id = p_target_user_id
          )
          OR (
            assignment.user_id = p_target_user_id
            AND response.respondent_id = p_source_user_id
          )
        )
    );
END;
$$;

REVOKE ALL ON FUNCTION
  public.preview_project_member_unification(UUID, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.preview_project_member_unification(UUID, UUID, UUID)
  TO service_role;

-- Escritas que transformam a posse de e-mail em acesso carregam a versão exata
-- do snapshot Clerk reconciliado. A mesma trava usada pelos webhooks torna a
-- prova e a mutação uma única decisão: se um snapshot mais novo venceu, a
-- escrita falha; se a escrita venceu, o webhook posterior remove o alias.
CREATE OR REPLACE FUNCTION public.assert_identity_write_proof(
  p_user_id UUID,
  p_email TEXT,
  p_expected_snapshot_version BIGINT
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_email TEXT := pg_catalog.lower(pg_catalog.btrim(p_email));
  v_profile_email TEXT;
  v_activated_at TIMESTAMPTZ;
  v_access_sync_version INTEGER;
  v_access_snapshot_version BIGINT;
  v_clerk_deleted BOOLEAN;
BEGIN
  IF NULLIF(v_email, '') IS NULL THEN
    RAISE EXCEPTION 'e-mail canônico é obrigatório'
      USING ERRCODE = '22023';
  END IF;

  IF p_expected_snapshot_version IS NOT NULL THEN
    SELECT
      mapping.access_sync_version,
      mapping.access_snapshot_version,
      mapping.clerk_deleted
    INTO
      v_access_sync_version,
      v_access_snapshot_version,
      v_clerk_deleted
    FROM public.clerk_user_mapping mapping
    WHERE mapping.supabase_user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND
       OR v_clerk_deleted
       OR v_access_sync_version < 1
       OR v_access_snapshot_version <> p_expected_snapshot_version
    THEN
      RAISE EXCEPTION 'snapshot Clerk mudou antes da escrita de identidade'
        USING ERRCODE = '40001';
    END IF;
    RETURN;
  END IF;

  SELECT profile.email, profile.activated_at
  INTO v_profile_email, v_activated_at
  FROM public.profiles profile
  WHERE profile.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_activated_at IS NOT NULL
     OR pg_catalog.lower(pg_catalog.btrim(v_profile_email)) <> v_email
  THEN
    RAISE EXCEPTION 'placeholder deixou de ser reclamável'
      USING ERRCODE = '40001';
  END IF;

  PERFORM 1
  FROM public.clerk_user_mapping mapping
  WHERE mapping.supabase_user_id = p_user_id
  FOR UPDATE;

  IF FOUND THEN
    RAISE EXCEPTION 'placeholder já possui identidade Clerk'
      USING ERRCODE = '40001';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_identity_write_proof(UUID, TEXT, BIGINT)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.add_project_member_with_identity_proof(
  p_project_id UUID,
  p_user_id UUID,
  p_role TEXT,
  p_email TEXT,
  p_expected_snapshot_version BIGINT
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('canonical-project-identity', 0)
  );
  PERFORM public.assert_identity_write_proof(
    p_user_id,
    p_email,
    p_expected_snapshot_version
  );

  INSERT INTO public.project_members (project_id, user_id, role)
  VALUES (p_project_id, p_user_id, p_role);
END;
$$;

REVOKE ALL ON FUNCTION public.add_project_member_with_identity_proof(
  UUID, UUID, TEXT, TEXT, BIGINT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_project_member_with_identity_proof(
  UUID, UUID, TEXT, TEXT, BIGINT
) TO service_role;

CREATE OR REPLACE FUNCTION public.write_member_email_link_with_identity_proof(
  p_project_id UUID,
  p_member_user_id UUID,
  p_email TEXT,
  p_linked_user_id UUID,
  p_created_by UUID,
  p_existing_link_id UUID,
  p_expected_linked_user_id UUID,
  p_expected_snapshot_version BIGINT
) RETURNS SETOF public.member_email_links
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_email TEXT := pg_catalog.lower(pg_catalog.btrim(p_email));
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('canonical-project-identity', 0)
  );

  IF p_linked_user_id IS NOT NULL THEN
    PERFORM public.assert_identity_write_proof(
      p_linked_user_id,
      v_email,
      p_expected_snapshot_version
    );
  ELSIF p_expected_snapshot_version IS NOT NULL THEN
    RAISE EXCEPTION 'snapshot Clerk sem identidade vinculada'
      USING ERRCODE = '22023';
  END IF;

  IF p_existing_link_id IS NULL THEN
    RETURN QUERY
    INSERT INTO public.member_email_links AS link (
      project_id,
      member_user_id,
      email,
      linked_user_id,
      created_by
    ) VALUES (
      p_project_id,
      p_member_user_id,
      v_email,
      p_linked_user_id,
      p_created_by
    )
    RETURNING link.*;
    RETURN;
  END IF;

  RETURN QUERY
  UPDATE public.member_email_links AS link
  SET linked_user_id = p_linked_user_id
  WHERE link.id = p_existing_link_id
    AND link.project_id = p_project_id
    AND link.member_user_id = p_member_user_id
    AND link.email = v_email
    AND link.linked_user_id IS NOT DISTINCT FROM p_expected_linked_user_id
  RETURNING link.*;
END;
$$;

REVOKE ALL ON FUNCTION public.write_member_email_link_with_identity_proof(
  UUID, UUID, TEXT, UUID, UUID, UUID, UUID, BIGINT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.write_member_email_link_with_identity_proof(
  UUID, UUID, TEXT, UUID, UUID, UUID, UUID, BIGINT
) TO service_role;

-- A verificação ocorre antes de qualquer mutação. Source e target são
-- memberships terminais; uma conta já vinculada não pode chegar a esta RPC.
DROP FUNCTION IF EXISTS public.unify_project_members(UUID, UUID, UUID, UUID);
DROP FUNCTION IF EXISTS public.unify_project_members(
  UUID, UUID, UUID, UUID, TEXT, UUID
);
CREATE FUNCTION public.unify_project_members(
  p_project_id UUID,
  p_source_user_id UUID,
  p_target_user_id UUID,
  p_linked_user_id UUID,
  p_link_email TEXT,
  p_acting_user_id UUID,
  p_expected_snapshot_version BIGINT
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_locked_membership_count INTEGER;
  v_review_conflicts BIGINT;
  v_arbitration_conflicts BIGINT;
  v_comparison_conflicts BIGINT;
BEGIN
  IF p_source_user_id = p_target_user_id THEN
    RAISE EXCEPTION 'source e target devem ser membros distintos';
  END IF;
  IF btrim(p_link_email) = '' THEN
    RAISE EXCEPTION 'e-mail do vínculo não pode ser vazio';
  END IF;
  IF p_linked_user_id = p_target_user_id THEN
    RAISE EXCEPTION 'a conta vinculada já é o membro de destino'
      USING ERRCODE = '23514';
  END IF;

  -- A gestão de identidade toma o lock global antes de qualquer linha.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('canonical-project-identity', 0)
  );

  PERFORM public.assert_identity_write_proof(
    p_linked_user_id,
    p_link_email,
    p_expected_snapshot_version
  );
  IF p_linked_user_id <> p_source_user_id THEN
    PERFORM public.assert_identity_write_proof(
      p_source_user_id,
      p_link_email,
      NULL
    );
  END IF;

  -- A ordem global dos UUIDs evita deadlocks entre unificações sobrepostas.
  -- Depois de aguardar um lock, READ COMMITTED reavalia a linha atualizada ou
  -- removida; por isso a contagem também é a validação de membership.
  PERFORM pm.user_id
  FROM public.project_members pm
  WHERE pm.project_id = p_project_id
    AND pm.user_id IN (p_source_user_id, p_target_user_id)
  ORDER BY pm.user_id
  FOR UPDATE;
  GET DIAGNOSTICS v_locked_membership_count = ROW_COUNT;

  IF v_locked_membership_count <> 2 THEN
    RAISE EXCEPTION 'source e target devem ser membros do projeto';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.member_email_links mel
    WHERE mel.project_id = p_project_id
      AND mel.email = lower(btrim(p_link_email))
      AND mel.member_user_id NOT IN (p_source_user_id, p_target_user_id)
  ) THEN
    RAISE EXCEPTION 'e-mail já está vinculado a outro membro do projeto'
      USING ERRCODE = '23514';
  END IF;

  -- DML já em voo termina antes destes locks; novo DML espera o commit da
  -- unificação. A ordem membership→tabelas acompanha as RPCs de permissão e
  -- remoção, evitando ciclo com transações que já bloquearam a membership.
  -- field_reviews precede assignments porque as RPCs de arbitragem atualizam
  -- essas duas tabelas nessa ordem; reviews e responses precedem assignments
  -- para acompanhar replace_and_add_documents.
  LOCK TABLE
    public.field_reviews,
    public.reviews,
    public.responses,
    public.assignments,
    public.researcher_field_orders,
    public.response_equivalences,
    public.verdict_acknowledgments
  IN SHARE ROW EXCLUSIVE MODE;

  SELECT
    preview.review_conflicts,
    preview.arbitration_conflicts,
    preview.comparison_conflicts
  INTO STRICT
    v_review_conflicts,
    v_arbitration_conflicts,
    v_comparison_conflicts
  FROM public.preview_project_member_unification(
    p_project_id,
    p_source_user_id,
    p_target_user_id
  ) preview;

  IF v_arbitration_conflicts > 0 THEN
    RAISE EXCEPTION
      'source e target participam da mesma arbitragem pendente'
      USING ERRCODE = '23514';
  END IF;

  IF v_review_conflicts > 0 THEN
    RAISE EXCEPTION
      'source e target possuem revisões do mesmo campo; a unificação preserva ambas e deve ser cancelada'
      USING ERRCODE = '23514';
  END IF;

  IF v_comparison_conflicts > 0 THEN
    RAISE EXCEPTION
      'source e target tornariam revisor e codificador da mesma comparação a mesma pessoa'
      USING ERRCODE = '23514';
  END IF;

  -- ===== assignments (colisão: target prevalece) =====
  -- Precedência do target vale para a identidade e para o progresso: uma
  -- codificação concluída do target supera uma em andamento do source, e o
  -- DELETE abaixo descarta a do source sem dó.
  --
  -- Auto-revisão e arbitragem são as exceções, porque o trabalho delas não
  -- vive no assignment e sim nos field_reviews, que a fusão transfere logo
  -- adiante: field_reviews é
  -- UNIQUE(document_id, field_name), então source e target podem deter campos
  -- distintos do MESMO documento. Se o target já concluiu a fila daquele
  -- documento e o source deixou campos sem veredito, descartar o assignment do
  -- source faria os field_reviews pendentes migrarem para uma fila fechada —
  -- estado que a pós-condição de 20260716160300 trata como erro de deploy, e
  -- que sumiria o documento da fila do target sem volta. Reabrir só quando há
  -- pendência real migrando mantém a regra estreita: nenhum outro tipo é
  -- tocado, e nada é reaberto sem trabalho a fazer.
  UPDATE public.assignments t
  SET status = 'pendente',
      completed_at = NULL
  WHERE t.project_id = p_project_id
    AND t.user_id = p_target_user_id
    AND t.type = 'auto_revisao'
    AND t.status = 'concluido'
    AND EXISTS (
      SELECT 1
      FROM public.field_reviews fr
      WHERE fr.project_id = p_project_id
        AND fr.document_id = t.document_id
        AND fr.self_reviewer_id = p_source_user_id
        AND fr.self_verdict IS NULL
    );

  -- A arbitragem tem a MESMA anatomia (trabalho nos field_reviews, não no
  -- assignment) e o mesmo buraco: campos contestados de levas distintas podem
  -- deixar o source com fila pendente enquanto o target já concluiu a dele no
  -- mesmo documento. Sem reabrir, o DELETE abaixo migraria final_verdict IS
  -- NULL para debaixo de assignment 'concluido' — e nenhum caminho reabre
  -- arbitragem depois (assign_arbitration_if_eligible só pega arbitrator_id
  -- IS NULL; sync_arbitration_assignment_status só fecha): o documento
  -- sumiria da fila de arbitragem para sempre.
  UPDATE public.assignments t
  SET status = 'pendente',
      completed_at = NULL
  WHERE t.project_id = p_project_id
    AND t.user_id = p_target_user_id
    AND t.type = 'arbitragem'
    AND t.status = 'concluido'
    AND EXISTS (
      SELECT 1
      FROM public.field_reviews fr
      WHERE fr.project_id = p_project_id
        AND fr.document_id = t.document_id
        AND fr.arbitrator_id = p_source_user_id
        AND fr.final_verdict IS NULL
    );

  DELETE FROM public.assignments s
  WHERE s.project_id = p_project_id
    AND s.user_id = p_source_user_id
    AND EXISTS (
      SELECT 1 FROM public.assignments t
      WHERE t.project_id = p_project_id
        AND t.user_id = p_target_user_id
        AND t.document_id = s.document_id
        AND t.type = s.type
    );
  UPDATE public.assignments
  SET user_id = p_target_user_id
  WHERE project_id = p_project_id AND user_id = p_source_user_id;

  -- ===== responses =====
  UPDATE public.responses
  SET respondent_id = p_target_user_id
  WHERE project_id = p_project_id AND respondent_id = p_source_user_id;

  WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY document_id
             ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
           ) AS rn
    FROM public.responses
    WHERE project_id = p_project_id
      AND respondent_id = p_target_user_id
      AND respondent_type = 'humano'
      AND is_latest
  )
  UPDATE public.responses r
  SET is_latest = false
  FROM ranked
  WHERE r.id = ranked.id AND ranked.rn > 1;

  -- ===== reviews =====
  -- Colisões foram rejeitadas antes da primeira mutação para que nenhuma
  -- revisão histórica seja descartada.
  UPDATE public.reviews
  SET reviewer_id = p_target_user_id
  WHERE project_id = p_project_id AND reviewer_id = p_source_user_id;

  -- ===== verdict_acknowledgments (target prevalece) =====
  DELETE FROM public.verdict_acknowledgments s
  WHERE s.respondent_id = p_source_user_id
    AND s.review_id IN (
      SELECT id FROM public.reviews WHERE project_id = p_project_id
    )
    AND EXISTS (
      SELECT 1 FROM public.verdict_acknowledgments t
      WHERE t.review_id = s.review_id
        AND t.respondent_id = p_target_user_id
    );
  UPDATE public.verdict_acknowledgments
  SET respondent_id = p_target_user_id
  WHERE respondent_id = p_source_user_id
    AND review_id IN (
      SELECT id FROM public.reviews WHERE project_id = p_project_id
    );

  -- ===== field_reviews =====
  UPDATE public.field_reviews
  SET self_reviewer_id = p_target_user_id
  WHERE project_id = p_project_id AND self_reviewer_id = p_source_user_id;
  UPDATE public.field_reviews
  SET arbitrator_id = p_target_user_id
  WHERE project_id = p_project_id AND arbitrator_id = p_source_user_id;

  -- ===== response_equivalences =====
  UPDATE public.response_equivalences
  SET reviewer_id = p_target_user_id
  WHERE project_id = p_project_id AND reviewer_id = p_source_user_id;

  -- Preferência pessoal do source não é herdada.
  DELETE FROM public.researcher_field_orders
  WHERE project_id = p_project_id AND user_id = p_source_user_id;

  -- Vínculos que tinham o source como identidade canônica passam ao target.
  UPDATE public.member_email_links
  SET member_user_id = p_target_user_id
  WHERE project_id = p_project_id AND member_user_id = p_source_user_id;

  -- A membership precisa sair antes do alias source→target: o trigger torna a
  -- coexistência irrepresentável. Falha posterior reverte toda a transação.
  DELETE FROM public.project_members
  WHERE project_id = p_project_id AND user_id = p_source_user_id;

  INSERT INTO public.member_email_links
    (project_id, member_user_id, email, linked_user_id, created_by)
  VALUES
    (
      p_project_id,
      p_target_user_id,
      lower(btrim(p_link_email)),
      p_linked_user_id,
      p_acting_user_id
    )
  ON CONFLICT (project_id, email) DO UPDATE
  SET member_user_id = EXCLUDED.member_user_id,
      linked_user_id = EXCLUDED.linked_user_id,
      created_by = EXCLUDED.created_by;
END;
$$;

REVOKE ALL ON FUNCTION
  public.unify_project_members(UUID, UUID, UUID, UUID, TEXT, UUID, BIGINT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.unify_project_members(UUID, UUID, UUID, UUID, TEXT, UUID, BIGINT)
  TO service_role;

-- ========== 6. Backfill: autoria histórica de conta-alias vira canônica ====
-- Antes desta migration, equivalências, acknowledgments e ordem de campos
-- eram gravados com o uid CRU da sessão (`user.id`), enquanto as filas já
-- resolviam a identidade canônica — uma conta vinculada trabalhando a fila do
-- membro deixou linhas sob o próprio uid. Como auth_user_member_identity_ids
-- deixa de devolver o uid cru e as policies acima só reconhecem identidades
-- canônicas, essas linhas ficariam órfãs (invisíveis e indeléveis para a
-- própria autora; re-ack criaria segunda linha). Reescrevê-las aqui, uma vez.
-- Colisões alias×canônico seguem a regra do unify: a linha canônica
-- prevalece e a do alias cai.

-- response_equivalences: UNIQUE(project_id, document_id, field_name,
-- response_a_id, response_b_id) não envolve reviewer_id, então a reescrita
-- não colide — basta o UPDATE.
UPDATE public.response_equivalences AS equivalence
SET reviewer_id = link.member_user_id
FROM public.member_email_links AS link
WHERE link.project_id = equivalence.project_id
  AND link.linked_user_id = equivalence.reviewer_id;

-- verdict_acknowledgments: UNIQUE(review_id, respondent_id); sem project_id
-- próprio, o escopo vem da review. Se alias e canônico reconheceram a mesma
-- review, a linha canônica prevalece.
DELETE FROM public.verdict_acknowledgments AS stale
USING public.reviews AS review,
      public.member_email_links AS link
WHERE review.id = stale.review_id
  AND link.project_id = review.project_id
  AND link.linked_user_id = stale.respondent_id
  AND EXISTS (
    SELECT 1
    FROM public.verdict_acknowledgments AS canonical
    WHERE canonical.review_id = stale.review_id
      AND canonical.respondent_id = link.member_user_id
  );

UPDATE public.verdict_acknowledgments AS acknowledgment
SET respondent_id = link.member_user_id
FROM public.reviews AS review,
     public.member_email_links AS link
WHERE review.id = acknowledgment.review_id
  AND link.project_id = review.project_id
  AND link.linked_user_id = acknowledgment.respondent_id;

-- researcher_field_orders: UNIQUE(project_id, user_id); preferência do
-- canônico prevalece, como no unify.
DELETE FROM public.researcher_field_orders AS stale
USING public.member_email_links AS link
WHERE link.project_id = stale.project_id
  AND link.linked_user_id = stale.user_id
  AND EXISTS (
    SELECT 1
    FROM public.researcher_field_orders AS canonical
    WHERE canonical.project_id = stale.project_id
      AND canonical.user_id = link.member_user_id
  );

UPDATE public.researcher_field_orders AS field_order
SET user_id = link.member_user_id
FROM public.member_email_links AS link
WHERE link.project_id = field_order.project_id
  AND link.linked_user_id = field_order.user_id;

COMMIT;
