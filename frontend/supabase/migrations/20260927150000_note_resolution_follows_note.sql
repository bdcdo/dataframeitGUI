-- A resolução de uma anotação vale enquanto a anotação não muda (#760).
--
-- `note_resolutions` marca como resolvida a anotação geral do pesquisador,
-- guardada em `responses.justifications._notes`, e é presa ao `response_id`.
-- Dentro de uma rodada, salvar a codificação é um UPDATE na mesma linha de
-- `responses` (`persistResponseRow` em frontend/src/actions/responses.ts), e
-- nada apagava a resolução quando a anotação era reescrita: a anotação nova
-- nascia resolvida e não aparecia como aberta na aba de comentários.
--
-- Regra: o gatilho que já derruba auto-revisões e pares "=" quando a resposta
-- muda passa a apagar a resolução da anotação daquela resposta quando
-- `justifications->'_notes'` muda, inclusive quando a chave some (anotação
-- apagada). Resposta salva com a mesma anotação mantém a resolução, e a
-- rebaixa de `is_latest` sozinha também: a linha antiga fica congelada com o
-- mesmo texto, e a aba de comentários continua a mostrá-la como resolvida.
-- `note_resolutions.note` é o comentário de quem resolveu, não o texto da
-- anotação, por isso a comparação é entre OLD e NEW no gatilho.
--
-- A tabela não guarda o texto resolvido, então o que já foi reescrito antes
-- desta migration não se recupera: a regra vale daqui para frente.
--
-- O corpo abaixo é o de 20260717120000_auto_review_reconciliation_outbox.sql
-- sem mudança, mais o bloco de `note_resolutions`. O gatilho continua o mesmo
-- (`UPDATE OF answers, justifications, is_latest`, com `justifications` no
-- WHEN), e o REVOKE repete o do original.

BEGIN;

CREATE OR REPLACE FUNCTION public.archive_review_dependencies_on_response_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.field_reviews AS review
  WHERE (
    review.human_response_id = NEW.id
    AND (
      OLD.is_latest = true AND NEW.is_latest = false
      OR review.human_answer_snapshot IS DISTINCT FROM
         NEW.answers -> review.field_name
    )
  ) OR (
    review.llm_response_id = NEW.id
    AND (
      OLD.is_latest = true AND NEW.is_latest = false
      OR review.llm_answer_snapshot IS DISTINCT FROM
         NEW.answers -> review.field_name
      OR review.llm_justification_snapshot IS DISTINCT FROM
         NEW.justifications -> review.field_name
    )
  );

  DELETE FROM public.response_equivalences AS equivalence
  WHERE (
    equivalence.response_a_id = NEW.id
    AND (
      OLD.is_latest = true AND NEW.is_latest = false
      OR equivalence.response_a_answer_snapshot IS DISTINCT FROM
         NEW.answers -> equivalence.field_name
    )
  ) OR (
    equivalence.response_b_id = NEW.id
    AND (
      OLD.is_latest = true AND NEW.is_latest = false
      OR equivalence.response_b_answer_snapshot IS DISTINCT FROM
         NEW.answers -> equivalence.field_name
    )
  );

  -- A resolução julgou o texto que estava em `_notes`; outro texto, ou a
  -- anotação apagada, é outra anotação e volta aberta ao coordenador.
  IF OLD.justifications -> '_notes' IS DISTINCT FROM
     NEW.justifications -> '_notes' THEN
    DELETE FROM public.note_resolutions AS resolution
    WHERE resolution.response_id = NEW.id;
  END IF;

  UPDATE public.assignments AS assignment
  SET status = 'concluido', completed_at = pg_catalog.now()
  WHERE assignment.project_id = NEW.project_id
    AND assignment.document_id = NEW.document_id
    AND assignment.type = 'auto_revisao'
    AND NOT EXISTS (
      SELECT 1
      FROM public.field_reviews AS review
      WHERE review.project_id = assignment.project_id
        AND review.document_id = assignment.document_id
        AND review.self_reviewer_id = assignment.user_id
        AND review.self_verdict IS NULL
    );

  DELETE FROM public.assignments AS assignment
  WHERE assignment.project_id = NEW.project_id
    AND assignment.document_id = NEW.document_id
    AND assignment.type = 'arbitragem'
    AND assignment.status <> 'concluido'
    AND NOT EXISTS (
      SELECT 1
      FROM public.field_reviews AS review
      WHERE review.project_id = assignment.project_id
        AND review.document_id = assignment.document_id
        AND review.arbitrator_id = assignment.user_id
        AND review.final_verdict IS NULL
    );

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.archive_review_dependencies_on_response_change()
  FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
