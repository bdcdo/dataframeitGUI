BEGIN;

-- O preflight e os triggers entram juntos: não pode haver uma janela em que
-- assignments/responses mudem depois da inspeção e antes da nova invariante.
LOCK TABLE public.responses, public.assignments
  IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.assignments
    WHERE status IS NULL
  ) THEN
    RAISE EXCEPTION 'assignments contém status NULL'
      USING ERRCODE = '23502';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.assignments assignment
    JOIN public.responses response
      ON response.project_id = assignment.project_id
     AND response.document_id = assignment.document_id
     AND response.respondent_id = assignment.user_id
     AND response.respondent_type = 'humano'
     AND response.is_latest
    WHERE assignment.type = 'comparacao'
      AND assignment.status IS DISTINCT FROM 'concluido'
  ) THEN
    RAISE EXCEPTION
      'há comparação aberta em que revisor e codificador são a mesma pessoa'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER TABLE public.assignments
  ALTER COLUMN status SET NOT NULL;

-- Toda criação dos dois lados da relação toma a mesma trava. Depois dela, o
-- trigger verifica o lado oposto; assim response e assignment concorrentes
-- não conseguem construir um estado em que revisor e codificador coincidem.
CREATE OR REPLACE FUNCTION public.lock_comparison_document(
  p_project_id UUID,
  p_document_id UUID
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'comparison:' || p_project_id::text || ':' || p_document_id::text,
      0
    )
  )
$$;

REVOKE ALL ON FUNCTION public.lock_comparison_document(UUID, UUID)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.lock_comparison_document(UUID, UUID)
  TO service_role;

CREATE OR REPLACE FUNCTION public.enforce_comparison_assignment_actor()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.type <> 'comparacao'
     OR NEW.status IS NOT DISTINCT FROM 'concluido'
  THEN
    RETURN NEW;
  END IF;

  PERFORM public.lock_comparison_document(NEW.project_id, NEW.document_id);

  IF EXISTS (
    SELECT 1
    FROM public.responses response
    WHERE response.project_id = NEW.project_id
      AND response.document_id = NEW.document_id
      AND response.respondent_id = NEW.user_id
      AND response.respondent_type = 'humano'
      AND response.is_latest
  ) THEN
    RAISE EXCEPTION
      'o codificador do documento não pode receber sua comparação'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_comparison_assignment_actor()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS enforce_comparison_assignment_actor_trigger
  ON public.assignments;
CREATE TRIGGER enforce_comparison_assignment_actor_trigger
  BEFORE INSERT OR UPDATE OF project_id, document_id, user_id, type, status
  ON public.assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_comparison_assignment_actor();

CREATE OR REPLACE FUNCTION public.enforce_comparison_response_actor()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.respondent_type <> 'humano'
     OR NOT NEW.is_latest
     OR NEW.respondent_id IS NULL
  THEN
    RETURN NEW;
  END IF;

  PERFORM public.lock_comparison_document(NEW.project_id, NEW.document_id);

  IF EXISTS (
    SELECT 1
    FROM public.assignments assignment
    WHERE assignment.project_id = NEW.project_id
      AND assignment.document_id = NEW.document_id
      AND assignment.user_id = NEW.respondent_id
      AND assignment.type = 'comparacao'
      AND assignment.status IS DISTINCT FROM 'concluido'
  ) THEN
    RAISE EXCEPTION
      'o revisor da comparação não pode codificar o mesmo documento'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_comparison_response_actor()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS enforce_comparison_response_actor_trigger
  ON public.responses;
CREATE TRIGGER enforce_comparison_response_actor_trigger
  BEFORE INSERT OR UPDATE OF
    project_id,
    document_id,
    respondent_id,
    respondent_type,
    is_latest
  ON public.responses
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_comparison_response_actor();

-- A atribuição e o fechamento da mesma fila usam uma única chave. Assim, em
-- qualquer ordem concorrente, ou o fechamento observa o novo campo pendente,
-- ou a atribuição posterior reabre o assignment depois do fechamento.
CREATE OR REPLACE FUNCTION public.lock_arbitration_assignment(
  p_project_id UUID,
  p_document_id UUID,
  p_user_id UUID
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'arbitration-assignment:'
        || p_project_id::text || ':'
        || p_document_id::text || ':'
        || p_user_id::text,
      0
    )
  )
$$;

-- Só chamada de dentro das RPCs de arbitragem: os sync_* são SECURITY DEFINER
-- (rodam como owner) e assign_arbitration_if_eligible, embora INVOKER, é
-- concedida apenas a service_role. Conceder a authenticated deixaria qualquer
-- sessão segurar o advisory lock da fila alheia sem passar por gate nenhum.
REVOKE ALL ON FUNCTION public.lock_arbitration_assignment(UUID, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lock_arbitration_assignment(UUID, UUID, UUID)
  TO service_role;

CREATE OR REPLACE FUNCTION public.sync_arbitration_assignment_status(
  p_project_id UUID,
  p_document_id UUID,
  p_user_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF public.clerk_uid() IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.auth_user_member_identity_ids(p_project_id) AS identity(user_id)
    WHERE identity.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'usuário não pode sincronizar esta fila de arbitragem'
      USING ERRCODE = '42501';
  END IF;

  -- A mesma ordem membership→advisory usada pela atribuição evita ciclos com
  -- remoção/unificação de membros e mantém a identidade canônica estável.
  PERFORM 1
  FROM public.project_members AS pm
  WHERE pm.project_id = p_project_id
    AND pm.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  PERFORM public.lock_arbitration_assignment(
    p_project_id,
    p_document_id,
    p_user_id
  );

  IF EXISTS (
    SELECT 1
    FROM public.field_reviews AS review
    WHERE review.project_id = p_project_id
      AND review.document_id = p_document_id
      AND review.arbitrator_id = p_user_id
      AND review.final_verdict IS NULL
  ) THEN
    RETURN false;
  END IF;

  UPDATE public.assignments AS assignment
  SET status = 'concluido',
      completed_at = pg_catalog.statement_timestamp()
  WHERE assignment.project_id = p_project_id
    AND assignment.document_id = p_document_id
    AND assignment.user_id = p_user_id
    AND assignment.type = 'arbitragem'
    AND assignment.status IS DISTINCT FROM 'concluido';

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION
  public.sync_arbitration_assignment_status(UUID, UUID, UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  public.sync_arbitration_assignment_status(UUID, UUID, UUID)
  TO authenticated, service_role;

-- A aplicação já exclui o auto-revisor ao montar o pool, mas a gravação
-- atômica também precisa validar essa invariante. O lock da membership fecha
-- a corrida com alterações de elegibilidade e com a unificação; a invariante
-- terminal impede que uma conta vinculada também exista neste pool.
CREATE OR REPLACE FUNCTION public.assign_arbitration_if_eligible(
  p_project_id uuid,
  p_document_id uuid,
  p_user_id uuid,
  p_field_names text[]
) RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_assigned integer := 0;
BEGIN
  PERFORM 1
  FROM public.project_members AS pm
  WHERE pm.project_id = p_project_id
    AND pm.user_id = p_user_id
    AND pm.can_arbitrate = true
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  PERFORM public.lock_arbitration_assignment(
    p_project_id,
    p_document_id,
    p_user_id
  );

  WITH assigned_reviews AS (
    UPDATE public.field_reviews AS fr
    SET arbitrator_id = p_user_id
    WHERE fr.project_id = p_project_id
      AND fr.document_id = p_document_id
      AND fr.field_name = ANY(p_field_names)
      AND fr.arbitrator_id IS NULL
      AND fr.self_verdict = 'contesta_llm'
      AND fr.final_verdict IS NULL
      AND fr.self_reviewer_id <> p_user_id
    RETURNING fr.id
  )
  SELECT count(*)::integer
  INTO v_assigned
  FROM assigned_reviews;

  IF v_assigned > 0 THEN
    INSERT INTO public.assignments (
      project_id,
      document_id,
      user_id,
      type,
      status
    ) VALUES (
      p_project_id,
      p_document_id,
      p_user_id,
      'arbitragem',
      'pendente'
    )
    ON CONFLICT (document_id, user_id, type) DO UPDATE
    SET status = 'pendente',
        completed_at = NULL
    WHERE assignments.status = 'concluido';
  END IF;

  RETURN v_assigned;
END;
$$;

REVOKE ALL ON FUNCTION
  public.assign_arbitration_if_eligible(uuid, uuid, uuid, text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.assign_arbitration_if_eligible(uuid, uuid, uuid, text[])
  TO service_role;

CREATE OR REPLACE FUNCTION public.assign_comparison_if_eligible(
  p_project_id uuid,
  p_document_id uuid,
  p_user_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_inserted integer := 0;
BEGIN
  PERFORM 1
  FROM public.project_members AS pm
  WHERE pm.project_id = p_project_id
    AND pm.user_id = p_user_id
    AND pm.can_compare = true
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Unificação usa a mesma ordem membership→tabelas→advisory. Os locks ROW
  -- EXCLUSIVE continuam compatíveis entre operações comuns, mas impedem o
  -- ciclo em que uma RPC segurava o advisory enquanto aguardava as tabelas.
  LOCK TABLE public.responses, public.assignments IN ROW EXCLUSIVE MODE;

  PERFORM public.lock_comparison_document(p_project_id, p_document_id);

  IF EXISTS (
    SELECT 1
    FROM public.responses AS response
    WHERE response.project_id = p_project_id
      AND response.document_id = p_document_id
      AND response.respondent_type = 'humano'
      AND response.is_latest = true
      AND response.respondent_id = p_user_id
  ) THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.assignments AS assignment
    WHERE assignment.project_id = p_project_id
      AND assignment.document_id = p_document_id
      AND assignment.type = 'comparacao'
      AND assignment.status IS DISTINCT FROM 'concluido'
  ) THEN
    RETURN false;
  END IF;

  INSERT INTO public.assignments (
    project_id,
    document_id,
    user_id,
    type,
    status
  ) VALUES (
    p_project_id,
    p_document_id,
    p_user_id,
    'comparacao',
    'pendente'
  )
  -- Sem conflict target: além da unicidade por (documento, usuário, tipo), a
  -- migration 20260716120100 protege um único comparador ativo por documento
  -- com índice parcial. Assim o índice, e não a leitura acima, arbitra duas
  -- tentativas concorrentes sem transformar a disputa em unique_violation.
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  RETURN v_inserted = 1;
END;
$$;

REVOKE ALL ON FUNCTION
  public.assign_comparison_if_eligible(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.assign_comparison_if_eligible(uuid, uuid, uuid)
  TO service_role;

COMMIT;
