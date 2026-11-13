BEGIN;

-- Exceção à regra "o codificador do documento não recebe sua comparação"
-- (20260716160100). A regra continua o padrão; o coordenador pode liberá-la
-- numa atribuição de comparação específica — caso de uso: o pesquisador
-- compara a própria codificação com a do LLM quando passou muito tempo desde
-- a codificação ou quando a equipe é pequena demais para haver revisor
-- neutro. Os sorteios (automático e manual) continuam excluindo codificadores:
-- a exceção só nasce de um ato explícito do coordenador, por atribuição.
--
-- A liberação mora na própria linha da atribuição, e essas duas colunas são o
-- registro de auditoria: quem liberou e quando. O carimbo é do banco, não do
-- cliente (ver o gatilho de guarda abaixo).

LOCK TABLE public.assignments IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.assignments
  ADD COLUMN self_comparison_approved_by UUID REFERENCES public.profiles(id),
  ADD COLUMN self_comparison_approved_at TIMESTAMPTZ;

-- As duas colunas andam juntas, e só uma comparação pode carregar liberação:
-- numa codificação ela não teria sentido nenhum e só esperaria para
-- "valer" se a linha um dia fosse promovida.
ALTER TABLE public.assignments
  ADD CONSTRAINT assignments_self_comparison_approval_shape CHECK (
    (self_comparison_approved_by IS NULL) = (self_comparison_approved_at IS NULL)
    AND (self_comparison_approved_by IS NULL OR type = 'comparacao')
  );

-- Guarda da liberação. A policy "Researchers update own assignments" deixa o
-- pesquisador fazer UPDATE em qualquer coluna da própria atribuição, então a
-- RLS sozinha não impede que ele mesmo se libere. Este gatilho exige que toda
-- mudança nas colunas de liberação venha de coordenador (ou criador, ou
-- master) do projeto, e carimba quem e quando a partir da sessão — o valor
-- enviado pelo cliente é ignorado. Sem sessão Clerk (service role, migration,
-- psql) não há quem carimbar: aí o valor enviado vale, mas só se nomear um
-- coordenador ou o criador do projeto.
--
-- O nome começa com "assignments_" para disparar antes de
-- enforce_comparison_assignment_actor_trigger (ordem alfabética entre
-- gatilhos BEFORE da mesma tabela): a regra de autocomparação precisa ler a
-- liberação já validada.
CREATE OR REPLACE FUNCTION public.guard_self_comparison_approval()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor UUID := public.clerk_uid();
BEGIN
  -- A liberação vale para o par (documento, pessoa) que o coordenador viu,
  -- não para a linha: mover a linha para outro documento, outra pessoa ou
  -- outro projeto a descarta, e enforce_comparison_assignment_actor (que
  -- dispara depois deste) reavalia o par novo sem exceção. Sem isto, a
  -- policy de UPDATE da própria linha deixaria o pesquisador levar a
  -- liberação de D1 para um D2 que ele também codificou.
  IF TG_OP = 'UPDATE'
     AND OLD.self_comparison_approved_by IS NOT NULL
     AND (
       NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.document_id IS DISTINCT FROM OLD.document_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
     )
  THEN
    NEW.self_comparison_approved_by := NULL;
    NEW.self_comparison_approved_at := NULL;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.self_comparison_approved_by IS NOT DISTINCT FROM OLD.self_comparison_approved_by
     AND NEW.self_comparison_approved_at IS NOT DISTINCT FROM OLD.self_comparison_approved_at
  THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT'
     AND NEW.self_comparison_approved_by IS NULL
     AND NEW.self_comparison_approved_at IS NULL
  THEN
    RETURN NEW;
  END IF;

  IF v_actor IS NOT NULL THEN
    IF NOT (
      NEW.project_id IN (
        SELECT public.auth_user_coordinator_or_creator_project_ids()
      )
      OR public.is_master()
    ) THEN
      RAISE EXCEPTION
        'só o coordenador pode liberar a autocomparação'
        USING ERRCODE = '42501';
    END IF;

    IF NEW.self_comparison_approved_by IS NOT NULL THEN
      NEW.self_comparison_approved_by := v_actor;
      NEW.self_comparison_approved_at := pg_catalog.statement_timestamp();
    ELSE
      NEW.self_comparison_approved_at := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.self_comparison_approved_by IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.project_members pm
      WHERE pm.project_id = NEW.project_id
        AND pm.user_id = NEW.self_comparison_approved_by
        AND pm.role = 'coordenador'
    ) AND NOT EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = NEW.project_id
        AND p.created_by = NEW.self_comparison_approved_by
    ) THEN
      RAISE EXCEPTION
        'a autocomparação só pode ser liberada por coordenador do projeto'
        USING ERRCODE = '42501';
    END IF;
    NEW.self_comparison_approved_at := COALESCE(
      NEW.self_comparison_approved_at,
      pg_catalog.statement_timestamp()
    );
  ELSE
    NEW.self_comparison_approved_at := NULL;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_self_comparison_approval()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS assignments_guard_self_comparison_approval
  ON public.assignments;
CREATE TRIGGER assignments_guard_self_comparison_approval
  BEFORE INSERT OR UPDATE OF
    project_id,
    document_id,
    user_id,
    self_comparison_approved_by,
    self_comparison_approved_at
  ON public.assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_self_comparison_approval();

-- Mesma regra de 20260716160100, com a exceção: a atribuição liberada pelo
-- coordenador passa. A coluna de liberação entra na lista do UPDATE OF para
-- que retirar a liberação de uma comparação aberta do próprio codificador
-- seja recusado, em vez de deixar o estado proibido sem exceção que o
-- justifique.
CREATE OR REPLACE FUNCTION public.enforce_comparison_assignment_actor()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.type <> 'comparacao'
     OR NEW.status IS NOT DISTINCT FROM 'concluido'
     OR NEW.self_comparison_approved_by IS NOT NULL
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
      USING ERRCODE = '23514',
            HINT = 'o coordenador pode liberar a autocomparação nesta atribuição';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_comparison_assignment_actor()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS enforce_comparison_assignment_actor_trigger
  ON public.assignments;
CREATE TRIGGER enforce_comparison_assignment_actor_trigger
  BEFORE INSERT OR UPDATE OF
    project_id,
    document_id,
    user_id,
    type,
    status,
    self_comparison_approved_by
  ON public.assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_comparison_assignment_actor();

-- O lado das respostas: com a autocomparação liberada, o revisor pode
-- revisar a própria codificação antes de comparar — é o fluxo do caso de uso.
-- Sem liberação, segue proibido codificar o documento cuja comparação se tem
-- aberta.
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
      AND assignment.self_comparison_approved_by IS NULL
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

COMMIT;
