-- Guarda os triggers BEFORE DELETE de arquivamento contra o cascade da âncora.
--
-- Contexto (issue #524, exposta pela #557): field_review_cycle_history_entries e
-- response_equivalence_history_entries têm FK ON DELETE CASCADE para documents e
-- projects, e são preenchidas por triggers BEFORE DELETE em field_reviews /
-- response_equivalences. Isso é contraditório por construção: o CASCADE governa
-- linhas que já existem quando o DELETE começa, não uma inserida no meio dele.
--
-- Quando um DELETE em documents/projects cascateia para field_reviews (ou
-- response_equivalences), o trigger dispara DEPOIS que a linha da âncora já saiu
-- e tenta INSERIR na tabela de histórico referenciando por FK exatamente o
-- documento/projeto que está sendo apagado — violando
-- field_review_cycle_history_document_fk / _project_fk (e as análogas de
-- response_equivalence). Em produção isso aborta a transação inteira: apagar um
-- documento/projeto que tenha field_reviews/response_equivalences falha.
--
-- Correção: só arquivar quando as duas âncoras (documento E projeto) ainda
-- existem. Há apenas dois caminhos que apagam a linha operacional:
--   1. supersede legítimo (a linha vira histórico; âncora viva) → arquiva;
--   2. cascade de documento/projeto (âncora já removida) → nada a preservar: a
--      própria linha de histórico seria cascateada em seguida pela mesma FK.
-- O guard mantém intacta a limpeza por cascade e não deixa histórico órfão;
-- apenas evita o INSERT-no-meio-do-cascade. Não altera as FKs nem o CASCADE.

CREATE OR REPLACE FUNCTION public.archive_field_review_before_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_review public.field_reviews%ROWTYPE;
  v_reason TEXT;
BEGIN
  v_review := OLD;
  v_review.superseded_at := COALESCE(v_review.superseded_at, pg_catalog.now());

  SELECT CASE
    WHEN human.is_latest IS DISTINCT FROM true
      OR OLD.human_answer_snapshot IS DISTINCT FROM
         human.answers -> OLD.field_name
    THEN 'answer_changed'
    WHEN llm.is_latest IS DISTINCT FROM true
      OR OLD.llm_answer_snapshot IS DISTINCT FROM
         llm.answers -> OLD.field_name
      OR OLD.llm_justification_snapshot IS DISTINCT FROM
         llm.justifications -> OLD.field_name
    THEN 'llm_changed'
    ELSE 'no_longer_divergent'
  END
  INTO v_reason
  FROM public.responses AS human,
       public.responses AS llm
  WHERE human.id = OLD.human_response_id
    AND llm.id = OLD.llm_response_id;

  v_review.superseded_reason := COALESCE(
    v_review.superseded_reason,
    v_reason,
    'no_longer_divergent'
  );

  -- Só arquiva se as âncoras ainda existem. Se o DELETE veio do cascade de
  -- documento/projeto, a âncora já saiu e a linha de histórico seria cascateada
  -- em seguida de qualquer forma — arquivar aqui só violaria a FK.
  IF EXISTS (SELECT 1 FROM public.documents WHERE id = OLD.document_id)
     AND EXISTS (SELECT 1 FROM public.projects WHERE id = OLD.project_id)
  THEN
    INSERT INTO public.field_review_cycle_history_entries
    SELECT v_review.*
    ON CONFLICT (id) DO NOTHING;
  END IF;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.archive_field_review_before_delete()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.archive_response_equivalence_before_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_equivalence public.response_equivalences%ROWTYPE;
  v_reason TEXT;
BEGIN
  v_equivalence := OLD;
  v_equivalence.superseded_at := COALESCE(
    v_equivalence.superseded_at,
    pg_catalog.now()
  );
  SELECT CASE
    WHEN response_a.is_latest IS DISTINCT FROM true
      OR response_b.is_latest IS DISTINCT FROM true
    THEN 'response_revised'
    WHEN OLD.response_a_answer_snapshot IS DISTINCT FROM
         response_a.answers -> OLD.field_name
      OR OLD.response_b_answer_snapshot IS DISTINCT FROM
         response_b.answers -> OLD.field_name
    THEN 'answer_changed'
    ELSE 'manually_removed'
  END
  INTO v_reason
  FROM public.responses AS response_a,
       public.responses AS response_b
  WHERE response_a.id = OLD.response_a_id
    AND response_b.id = OLD.response_b_id;

  v_equivalence.superseded_reason := COALESCE(
    v_equivalence.superseded_reason,
    v_reason,
    'manually_removed'
  );

  -- Mesma guarda do arquivamento de field_reviews: só arquiva com as âncoras
  -- vivas; sob cascade de documento/projeto, a linha de histórico seria
  -- cascateada logo em seguida.
  IF EXISTS (SELECT 1 FROM public.documents WHERE id = OLD.document_id)
     AND EXISTS (SELECT 1 FROM public.projects WHERE id = OLD.project_id)
  THEN
    INSERT INTO public.response_equivalence_history_entries
    SELECT v_equivalence.*
    ON CONFLICT (id) DO NOTHING;
  END IF;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.archive_response_equivalence_before_delete()
  FROM PUBLIC, anon, authenticated, service_role;
