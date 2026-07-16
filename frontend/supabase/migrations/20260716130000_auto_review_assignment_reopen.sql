-- A fila da auto-revisão não voltava quando surgia trabalho novo.
--
-- createAutoReviewIfDiverges grava o assignment e os stubs de field_reviews com
-- upsert + ignoreDuplicates, que ignora a linha existente em vez de devolvê-la
-- para 'pendente'. Então, depois que o pesquisador conclui a auto-revisão de um
-- documento, qualquer campo que passe a divergir do LLM — ao editar a
-- codificação, por exemplo — nasce com self_verdict NULL enquanto o assignment
-- continua 'concluido'. O documento fica fora da fila com veredito por fazer, e
-- só volta por intervenção manual.
--
-- Os dois upserts também rodam em requests separadas, sem trava, e o fechamento
-- (syncAutoRevisaoAssignmentStatus, em TypeScript) lê as pendências e grava
-- 'concluido' em duas requests próprias: um stub criado entre a leitura e o
-- UPDATE não é enxergado, porque sob READ COMMITTED cada statement lê um
-- snapshot novo. Corrigir só o produtor não fecharia essa janela — uma trava com
-- um único tomador não serializa nada —, então esta migration move o fechamento
-- para o banco e faz os dois lados compartilharem a mesma chave.
--
-- A arbitragem resolve o problema irmão por outro desenho:
-- assign_arbitration_if_eligible (migration 20260715160000) é SECURITY INVOKER e
-- serializa por FOR UPDATE em project_members. Aqui a serialização não pode
-- pendurar-se na linha de membership: quem produz é o backend no fluxo de
-- saveResponse e quem fecha é o submit da própria fila, então a chave precisa
-- ser o par (documento, auto-revisor) — daí a trava consultiva abaixo.
BEGIN;

-- Atribuição e fechamento da mesma fila compartilham uma única chave, então em
-- qualquer ordem concorrente ou o fechamento enxerga o campo pendente novo, ou
-- a atribuição posterior reabre o assignment depois do fechamento.
CREATE OR REPLACE FUNCTION public.lock_auto_review_assignment(
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
      'auto-review-assignment:'
        || p_project_id::text || ':'
        || p_document_id::text || ':'
        || p_user_id::text,
      0
    )
  )
$$;

-- Ambos os chamadores (assign_auto_review_if_eligible e
-- sync_auto_review_assignment_status) são SECURITY DEFINER e rodam como owner,
-- que mantém o EXECUTE independentemente destes REVOKE. Nenhum role de runtime
-- precisa da trava avulsa, e concedê-la deixaria qualquer sessão segurar a fila
-- alheia até o fim da transação — daí service_role entrar no REVOKE também: as
-- default privileges do schema public dariam EXECUTE a ele por omissão.
REVOKE ALL ON FUNCTION public.lock_auto_review_assignment(UUID, UUID, UUID)
  FROM PUBLIC, anon, authenticated, service_role;

-- Chamada pelo backend (service_role) no fluxo de saveResponse, onde
-- clerk_uid() é NULL — por isso não há gate de identidade, e o REVOKE abaixo é o
-- que mantém a função fora do alcance de authenticated.
CREATE OR REPLACE FUNCTION public.assign_auto_review_if_eligible(
  p_project_id UUID,
  p_document_id UUID,
  p_self_reviewer_id UUID,
  p_field_names TEXT[],
  p_human_response_id UUID,
  p_llm_response_id UUID
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_created INTEGER;
BEGIN
  IF p_field_names IS NULL OR pg_catalog.array_length(p_field_names, 1) IS NULL
  THEN
    RETURN 0;
  END IF;

  -- Mesma chave do fechamento: a partir daqui, sync_auto_review_assignment_status
  -- para este (projeto, documento, revisor) espera esta transação terminar.
  PERFORM public.lock_auto_review_assignment(
    p_project_id,
    p_document_id,
    p_self_reviewer_id
  );

  INSERT INTO public.field_reviews (
    project_id,
    document_id,
    field_name,
    human_response_id,
    llm_response_id,
    self_reviewer_id
  )
  SELECT
    p_project_id,
    p_document_id,
    field_name,
    p_human_response_id,
    p_llm_response_id,
    p_self_reviewer_id
  FROM pg_catalog.unnest(p_field_names) AS field_name
  ON CONFLICT (document_id, field_name) DO NOTHING;

  GET DIAGNOSTICS v_created = ROW_COUNT;

  -- A reabertura é condicionada ao trabalho pendente real, não a v_created: um
  -- retry que não cria stub nenhum ainda precisa reabrir um assignment fechado
  -- cedo demais por uma execução anterior.
  INSERT INTO public.assignments (
    project_id,
    document_id,
    user_id,
    type,
    status
  ) VALUES (
    p_project_id,
    p_document_id,
    p_self_reviewer_id,
    'auto_revisao',
    'pendente'
  )
  ON CONFLICT (document_id, user_id, type) DO UPDATE
  SET status = 'pendente',
      completed_at = NULL
  WHERE assignments.status = 'concluido'
    AND EXISTS (
      SELECT 1
      FROM public.field_reviews AS review
      WHERE review.project_id = p_project_id
        AND review.document_id = p_document_id
        AND review.self_reviewer_id = p_self_reviewer_id
        AND review.self_verdict IS NULL
    );

  RETURN v_created;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_auto_review_if_eligible(
  UUID, UUID, UUID, TEXT[], UUID, UUID
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_auto_review_if_eligible(
  UUID, UUID, UUID, TEXT[], UUID, UUID
) TO service_role;

-- O outro tomador da trava. Antes o fechamento era SELECT de pendências seguido
-- de UPDATE, em duas requests do cliente admin: entre as duas, um stub recém
-- liberado para o mesmo (documento, auto-revisor) ficava invisível e o
-- assignment ia para 'concluido' com self_verdict IS NULL vivo. Trazido para o
-- banco, o EXISTS e o UPDATE passam a ler o mesmo snapshot sob a trava que
-- assign_auto_review_if_eligible também pega, então em qualquer ordem
-- concorrente ou o fechamento enxerga o campo novo, ou a atribuição reabre o
-- assignment depois do fechamento.
--
-- Chamada pelo backend (service_role) no submit da auto-revisão, onde clerk_uid()
-- é NULL: como no produtor, não há gate de identidade e o REVOKE é o que mantém
-- a função fora do alcance de authenticated.
CREATE OR REPLACE FUNCTION public.sync_auto_review_assignment_status(
  p_project_id UUID,
  p_document_id UUID,
  p_user_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.lock_auto_review_assignment(
    p_project_id,
    p_document_id,
    p_user_id
  );

  -- O envio é parcial: enquanto sobrar um campo sem veredito, o documento
  -- continua na fila.
  IF EXISTS (
    SELECT 1
    FROM public.field_reviews AS review
    WHERE review.project_id = p_project_id
      AND review.document_id = p_document_id
      AND review.self_reviewer_id = p_user_id
      AND review.self_verdict IS NULL
  ) THEN
    RETURN false;
  END IF;

  UPDATE public.assignments AS assignment
  SET status = 'concluido',
      completed_at = pg_catalog.statement_timestamp()
  WHERE assignment.project_id = p_project_id
    AND assignment.document_id = p_document_id
    AND assignment.user_id = p_user_id
    AND assignment.type = 'auto_revisao'
    AND assignment.status IS DISTINCT FROM 'concluido';

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION
  public.sync_auto_review_assignment_status(UUID, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.sync_auto_review_assignment_status(UUID, UUID, UUID)
  TO service_role;

-- Reconciliação em lote para a regeneração manual do backlog, que insere
-- assignments e field_reviews em passos separados e pela mesma razão não
-- reabria nada. Aqui não há trava por documento: é uma varredura idempotente
-- de coordenador, e o pior caso de uma corrida é outra rodada reabrir depois.
CREATE OR REPLACE FUNCTION public.reopen_auto_review_assignments_with_pending(
  p_project_id UUID
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_reopened INTEGER;
BEGIN
  UPDATE public.assignments AS assignment
  SET status = 'pendente',
      completed_at = NULL
  WHERE assignment.project_id = p_project_id
    AND assignment.type = 'auto_revisao'
    AND assignment.status = 'concluido'
    AND EXISTS (
      SELECT 1
      FROM public.field_reviews AS review
      WHERE review.project_id = assignment.project_id
        AND review.document_id = assignment.document_id
        AND review.self_reviewer_id = assignment.user_id
        AND review.self_verdict IS NULL
    );

  GET DIAGNOSTICS v_reopened = ROW_COUNT;
  RETURN v_reopened;
END;
$$;

REVOKE ALL ON FUNCTION
  public.reopen_auto_review_assignments_with_pending(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.reopen_auto_review_assignments_with_pending(UUID)
  TO service_role;

COMMIT;
