-- A mudanca da pergunta derruba os julgamentos presos a respostas.
--
-- O par "=" (`response_equivalences`), a auto-revisao (`field_reviews`) e a
-- decisao do LLM Insights (`error_resolutions`) ja caem quando a resposta muda
-- (gatilho archive_review_dependencies_on_response_change e o contexto
-- recalculado de llm_error_context). Esta migration faz a mudanca da DEFINICAO
-- da pergunta derruba-los tambem, com a mesma politica de hash ausente de
-- `reviews.field_hash` (20260926120000): sem hash nao ha como provar a versao,
-- e a ausencia nao invalida sozinha.
--
-- Por julgamento:
--
--   * Par "=": vale enquanto as duas respostas foram dadas a versao atual da
--     pergunta (o hash do campo em `answer_field_hashes` e o atual). A regra e
--     de leitura e vive em `filterCurrentEquivalencePairs`
--     (frontend/src/lib/equivalence.ts); o banco nao arquiva o par, porque a
--     resposta recodificada com outro valor ja o arquiva pelo gatilho de
--     resposta. Aqui so entra a escrita: `record_response_equivalences` passa
--     a recusar par com resposta de outra versao da pergunta, pela copia SQL
--     da regra (`response_answers_current_question`). A rodada nao entra:
--     resposta que deixou de ser `is_latest` fica congelada e pode ser parte
--     do par (o LLM Insights marca "=" com a resposta escolhida de outra
--     rodada).
--
--   * Auto-revisao: o ciclo carimba em `field_reviews.field_hash` o hash do
--     campo quando e aberto (INSERT) e quando e rotacionado (UPDATE OF
--     cycle_no). Ele vale enquanto o campo existe e o carimbo e o hash atual,
--     ou e NULL (legado). Os vereditos do ciclo foram dados sob o carimbo,
--     porque toda mudanca da pergunta encerra o ciclo:
--       - o gatilho de `projects` (archive_judgments_on_question_change)
--         arquiva, na mesma transacao do save do schema, todo ciclo que deixou
--         de valer, e enfileira a reconciliacao dos documentos cujo campo
--         continua existindo. O reconciliador abre um ciclo novo, pendente,
--         se a divergencia persistir sob a pergunta nova;
--       - campo renomeado ou removido encerra os ciclos do nome antigo
--         ('field_removed'), sem ciclo novo;
--       - reconcile_auto_review_cycles tambem encerra ciclo que nao vale
--         ('question_changed'), como defesa se algum caminho escapar do
--         gatilho, e o rotaciona como qualquer outro;
--       - a view final_answers marca 'pergunta_alterada' o ciclo que nao vale
--         e o campo que a geracao LLM nao respondeu (campo renomeado ou criado
--         depois da rodada), em vez de fabricar 'consenso' com resposta nula.
--
--   * Decisao do LLM Insights: a mudanca da pergunta ja a derrubava, porque o
--     contexto guarda a definicao inteira do campo (`field_definition`) e a
--     decisao so vale com o contexto recalculado identico. O que faltava: a
--     edicao da resposta de OUTRO codificador da celula. O contexto so
--     cobria a resposta humana escolhida; ganha `source.cell_answers_hash`,
--     o hash de todas as respostas humanas vigentes do documento no campo.
--     A fonte de auto-revisao passa a exigir o ciclo valido.
--
-- A copia TypeScript da validade do ciclo e `fieldReviewIsCurrent`
-- (frontend/src/lib/review-validity.ts); os casos de teste das duas copias sao
-- os mesmos.

BEGIN;

-- ── Campo por nome no schema do projeto ──────────────────────────────────────
-- Pura sobre o JSON, como `pydantic_fields_shape_valid`. NULL quando o campo
-- nao existe (removido ou renomeado).
CREATE FUNCTION public.pydantic_field_by_name(p_fields JSONB, p_name TEXT)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT field.value
  FROM pg_catalog.jsonb_array_elements(
    CASE WHEN pg_catalog.jsonb_typeof(p_fields) = 'array' THEN p_fields ELSE '[]'::JSONB END
  ) AS field(value)
  WHERE field.value->>'name' = p_name
  LIMIT 1;
$$;

-- ── Validade do ciclo de auto-revisao ────────────────────────────────────────
-- O campo existe e o carimbo e o hash atual, ou o carimbo e NULL (legado).
-- Campo atual sem hash com ciclo carimbado reprova, como em
-- `review_verdict_valid`.
CREATE FUNCTION public.field_review_question_current(p_field_hash TEXT, p_field JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT COALESCE(
    pg_catalog.jsonb_typeof(p_field) = 'object'
      AND (p_field_hash IS NULL OR p_field_hash = p_field->>'hash'),
    false);
$$;

-- A view final_answers e security_invoker: quem le a view executa as duas.
REVOKE ALL ON FUNCTION public.pydantic_field_by_name(JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pydantic_field_by_name(JSONB, TEXT) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.field_review_question_current(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.field_review_question_current(TEXT, JSONB) TO authenticated, service_role;

-- ── Carimbo do ciclo ─────────────────────────────────────────────────────────
-- A coluna entra nas duas tabelas, no fim, para que `INSERT ... SELECT
-- review.*` entre a operacional e o historico continue casando as colunas.
ALTER TABLE public.field_reviews ADD COLUMN field_hash TEXT;
ALTER TABLE public.field_review_cycle_history_entries ADD COLUMN field_hash TEXT;

-- Backfill do ciclo corrente, do mais confiavel ao menos: o hash do campo na
-- geracao LLM do ciclo (resposta de LLM nao e editada no lugar, e o ciclo so
-- existe depois dela), senao o da resposta humana, senao NULL (legado). Limite
-- conhecido: se a pergunta mudou entre a geracao LLM e a abertura do ciclo, o
-- carimbo inferido e o antigo e o ciclo cai, o lado conservador. O historico
-- fica sem carimbo: ninguem o le como julgamento vigente.
UPDATE public.field_reviews AS review
SET field_hash = COALESCE(
  CASE WHEN pg_catalog.jsonb_typeof(llm.answer_field_hashes->review.field_name) = 'string'
    THEN llm.answer_field_hashes->>review.field_name END,
  CASE WHEN pg_catalog.jsonb_typeof(human.answer_field_hashes->review.field_name) = 'string'
    THEN human.answer_field_hashes->>review.field_name END)
FROM public.responses AS llm, public.responses AS human
WHERE llm.id = review.llm_response_id
  AND human.id = review.human_response_id;

CREATE FUNCTION public.stamp_field_review_field_hash()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  SELECT public.pydantic_field_by_name(project.pydantic_fields, NEW.field_name)->>'hash'
  INTO NEW.field_hash
  FROM public.projects AS project
  WHERE project.id = NEW.project_id;
  RETURN NEW;
END;
$$;

-- Cliente nenhum muda o carimbo: sem isto a policy de UPDATE do revisor
-- deixaria gravar o hash atual num ciclo aberto sob outra pergunta. O
-- carimbo legitimo da rotacao vem de stamp_field_review_field_hash, que roda
-- depois deste (gatilhos BEFORE do mesmo evento disparam em ordem alfabetica
-- de nome) e por isso nao passa por ele.
CREATE FUNCTION public.enforce_field_review_field_hash_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.field_hash IS DISTINCT FROM OLD.field_hash THEN
    RAISE EXCEPTION 'field_reviews.field_hash e carimbada pelo servidor e nao pode ser alterada'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.stamp_field_review_field_hash()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_field_review_field_hash_immutable()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER field_reviews_field_hash_immutable
BEFORE UPDATE ON public.field_reviews
FOR EACH ROW EXECUTE FUNCTION public.enforce_field_review_field_hash_immutable();

CREATE TRIGGER stamp_field_review_field_hash
BEFORE INSERT OR UPDATE OF cycle_no ON public.field_reviews
FOR EACH ROW EXECUTE FUNCTION public.stamp_field_review_field_hash();

-- ── Motivos novos de encerramento do ciclo ──────────────────────────────────
ALTER TABLE public.field_reviews
  DROP CONSTRAINT field_reviews_superseded_reason_check,
  ADD CONSTRAINT field_reviews_superseded_reason_check CHECK (
    superseded_reason IS NULL OR superseded_reason IN (
      'answer_changed',
      'llm_changed',
      'no_longer_divergent',
      'legacy_response_changed',
      'question_changed',
      'field_removed'
    )
  );

-- O arquivamento por DELETE deduz o motivo; os dois novos vem depois dos de
-- resposta, para que a edicao de resposta continue nomeada como tal.
CREATE OR REPLACE FUNCTION public.archive_field_review_before_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_review public.field_reviews%ROWTYPE;
  v_reason TEXT;
  v_field JSONB;
BEGIN
  v_review := OLD;
  v_review.superseded_at := COALESCE(v_review.superseded_at, pg_catalog.now());

  SELECT public.pydantic_field_by_name(project.pydantic_fields, OLD.field_name)
  INTO v_field
  FROM public.projects AS project
  WHERE project.id = OLD.project_id;

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
    WHEN v_field IS NULL
    THEN 'field_removed'
    WHEN NOT public.field_review_question_current(OLD.field_hash, v_field)
    THEN 'question_changed'
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

  -- Mesma guarda de 20260724100000: so arquiva com as ancoras vivas.
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

-- ── Mudanca da pergunta encerra o ciclo, no save do schema ───────────────────
-- Arquiva todo ciclo do projeto que nao vale contra o schema atual. Idempotente:
-- o gatilho de `projects` a chama a cada save de schema, e o backfill abaixo,
-- uma vez por projeto. Devolve quantos ciclos arquivou.
CREATE FUNCTION public.archive_question_changed_field_reviews(p_project_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_project public.projects%ROWTYPE;
  v_archived INTEGER;
  v_documents UUID[];
  v_requeue UUID[];
BEGIN
  SELECT * INTO v_project FROM public.projects WHERE id = p_project_id;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  WITH archived AS (
    DELETE FROM public.field_reviews AS review
    WHERE review.project_id = v_project.id
      AND NOT public.field_review_question_current(
        review.field_hash,
        public.pydantic_field_by_name(v_project.pydantic_fields, review.field_name))
    RETURNING review.document_id, review.field_name
  )
  SELECT
    pg_catalog.count(*)::INTEGER,
    pg_catalog.array_agg(DISTINCT archived.document_id),
    pg_catalog.array_agg(DISTINCT archived.document_id) FILTER (
      WHERE public.pydantic_field_by_name(v_project.pydantic_fields, archived.field_name) IS NOT NULL)
  INTO v_archived, v_documents, v_requeue
  FROM archived;

  IF v_archived = 0 THEN
    RETURN 0;
  END IF;

  -- A mesma manutencao de assignments de archive_review_dependencies_on_response_change:
  -- sem ciclo pendente, a auto-revisao do documento fecha e a arbitragem aberta sai.
  UPDATE public.assignments AS assignment
  SET status = 'concluido', completed_at = pg_catalog.now()
  WHERE assignment.project_id = v_project.id
    AND assignment.document_id = ANY(v_documents)
    AND assignment.type = 'auto_revisao'
    AND assignment.status <> 'concluido'
    AND NOT EXISTS (
      SELECT 1
      FROM public.field_reviews AS review
      WHERE review.project_id = assignment.project_id
        AND review.document_id = assignment.document_id
        AND review.self_reviewer_id = assignment.user_id
        AND review.self_verdict IS NULL
    );

  DELETE FROM public.assignments AS assignment
  WHERE assignment.project_id = v_project.id
    AND assignment.document_id = ANY(v_documents)
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

  IF v_requeue IS NULL THEN
    RETURN v_archived;
  END IF;

  -- O campo continua existindo: o reconciliador reabre o ciclo, pendente, se a
  -- divergencia persistir sob a pergunta nova. Mesmo mutex por documento de
  -- enqueue_auto_review_reconciliation_for_project, e o mesmo pedido: so
  -- documento com geracao LLM corrente completa e codificacao humana completa.
  PERFORM 1
  FROM public.documents AS document
  WHERE document.id = ANY(v_requeue)
  ORDER BY document.id
  FOR UPDATE;

  INSERT INTO public.auto_review_reconciliation_requests (
    document_id, project_id, llm_response_id, allow_new_cycles
  )
  SELECT document.id, document.project_id, llm.id, v_project.automation_mode = 'auto_review_llm'
  FROM public.documents AS document
  JOIN LATERAL (
    SELECT response.id
    FROM public.responses AS response
    WHERE response.project_id = document.project_id
      AND response.document_id = document.id
      AND response.respondent_type = 'llm'
      AND response.is_latest = true
      AND response.is_partial = false
    LIMIT 1
  ) AS llm ON true
  WHERE document.project_id = v_project.id
    AND document.id = ANY(v_requeue)
    AND EXISTS (
      SELECT 1
      FROM public.responses AS human
      WHERE human.project_id = document.project_id
        AND human.document_id = document.id
        AND human.respondent_type = 'humano'
        AND human.is_latest = true
        AND human.is_partial = false
    )
  ON CONFLICT (document_id) DO UPDATE
  SET project_id = EXCLUDED.project_id,
      llm_response_id = EXCLUDED.llm_response_id,
      allow_new_cycles = EXCLUDED.allow_new_cycles,
      requested_at = pg_catalog.now(),
      next_attempt_at = pg_catalog.now(),
      attempt_count = 0,
      last_error = NULL;

  RETURN v_archived;
END;
$$;

REVOKE ALL ON FUNCTION public.archive_question_changed_field_reviews(UUID)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.archive_judgments_on_question_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.archive_question_changed_field_reviews(NEW.id);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.archive_judgments_on_question_change()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER archive_judgments_on_question_change
AFTER UPDATE OF pydantic_fields ON public.projects
FOR EACH ROW
WHEN (OLD.pydantic_fields IS DISTINCT FROM NEW.pydantic_fields)
EXECUTE FUNCTION public.archive_judgments_on_question_change();

-- Ciclo que o backfill ja carimbou com hash de outra versao da pergunta, ou de
-- campo que saiu do schema: a mesma regra do gatilho, uma vez por projeto,
-- para o estado nascer coerente.
DO $$
DECLARE
  v_archived BIGINT;
BEGIN
  SELECT COALESCE(pg_catalog.sum(public.archive_question_changed_field_reviews(project.id)), 0)
  INTO v_archived
  FROM public.projects AS project;
  RAISE NOTICE 'field_reviews: % ciclo(s) fora da pergunta atual arquivado(s) no backfill', v_archived;
END $$;

-- ── final_answers: nada de consenso ou veredito de outra versao da pergunta ──
-- Dois estados novos, os dois 'pergunta_alterada' e sem resposta:
--   * ciclo de auto-revisao que nao vale (carimbo de outra versao);
--   * campo sem ciclo que a geracao LLM corrente nao respondeu: o mapa
--     `answer_field_hashes` dela nao tem o campo (campo renomeado ou criado
--     depois da rodada). Sem esta guarda a view emitia 'consenso' com
--     resposta nula. Mapa legado (NULL ou `{}`) nao prova ausencia e segue
--     como antes, a mesma leitura de `fieldExistedWhenCoded`.
-- `field_review_field_hash` vai ao fim porque CREATE OR REPLACE VIEW so
-- acrescenta coluna depois das existentes.
CREATE OR REPLACE VIEW public.final_answers
WITH (security_invoker = true) AS
SELECT
  r_llm.project_id,
  r_llm.document_id,
  fld.field_name,
  CASE
    WHEN reconciliation.pending THEN NULL
    WHEN question.changed THEN NULL
    WHEN fr.id IS NULL THEN r_llm.answers -> fld.field_name
    WHEN fr.self_verdict IS NULL THEN NULL
    WHEN fr.self_verdict = 'admite_erro' THEN fr.llm_answer_snapshot
    WHEN fr.self_verdict = 'equivalente' THEN fr.human_answer_snapshot
    WHEN fr.self_verdict = 'ambiguo' THEN NULL
    WHEN fr.final_verdict IS NULL THEN NULL
    WHEN fr.final_verdict = 'humano' THEN fr.human_answer_snapshot
    WHEN fr.final_verdict = 'llm' THEN fr.llm_answer_snapshot
    ELSE NULL
  END AS answer,
  CASE
    WHEN reconciliation.pending THEN 'aguarda_reconciliacao'
    WHEN question.changed THEN 'pergunta_alterada'
    WHEN fr.id IS NULL THEN 'consenso'
    WHEN fr.self_verdict IS NULL THEN 'aguarda_auto_revisao'
    WHEN fr.self_verdict = 'admite_erro' THEN 'auto_corrigido'
    WHEN fr.self_verdict = 'equivalente' THEN 'equivalente'
    WHEN fr.self_verdict = 'ambiguo' THEN 'ambiguo'
    WHEN fr.final_verdict IS NULL THEN 'aguarda_arbitragem'
    ELSE 'arbitrado'
  END AS provenance,
  fr.id AS field_review_id,
  fr.changed_after_justification,
  fr.cycle_no,
  fr.self_verdict,
  fr.final_verdict,
  fr.self_reviewed_at,
  fr.final_decided_at,
  fr.human_response_id,
  fr.llm_response_id,
  fr.human_answer_snapshot,
  fr.llm_answer_snapshot,
  fr.arbitrator_comment,
  fr.field_hash AS field_review_field_hash
FROM public.responses AS r_llm
JOIN public.projects AS project ON project.id = r_llm.project_id
CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
  COALESCE(project.pydantic_fields, '[]'::JSONB)
) AS field_raw
CROSS JOIN LATERAL (SELECT field_raw->>'name' AS field_name) AS fld
LEFT JOIN public.field_reviews AS fr
  ON fr.document_id = r_llm.document_id
  AND fr.field_name = fld.field_name
  AND fr.superseded_at IS NULL
CROSS JOIN LATERAL (
  SELECT public.is_auto_review_reconciliation_pending(
    r_llm.project_id, r_llm.document_id, r_llm.id
  ) AS pending
) AS reconciliation
CROSS JOIN LATERAL (
  SELECT CASE
    WHEN fr.id IS NOT NULL
      THEN NOT public.field_review_question_current(fr.field_hash, field_raw)
    ELSE pg_catalog.jsonb_typeof(r_llm.answer_field_hashes) = 'object'
      AND r_llm.answer_field_hashes <> '{}'::JSONB
      AND NOT (r_llm.answer_field_hashes ? fld.field_name)
  END AS changed
) AS question
WHERE r_llm.respondent_type = 'llm'
  AND r_llm.is_latest = true;

-- Mesmo racional de grants de 20260820120000: REVOKE ALL, nao apenas SELECT.
REVOKE ALL ON public.final_answers FROM anon;
GRANT SELECT ON public.final_answers TO authenticated, service_role;

-- ── Reconciliador: ciclo fora da pergunta atual e encerrado e rotacionado ───
-- Corpo vivo (o de 20260717120000 com o alvo do ON CONFLICT que
-- 20260731120000 reescreveu para a chave por rodada) com tres mudancas: le
-- `pydantic_fields` junto do
-- hash do projeto; encerra tambem o ciclo que `field_review_question_current`
-- reprova; e nomeia os motivos 'field_removed' (campo fora do schema) e
-- 'question_changed' (carimbo de outra versao). A rotacao recarimba pelo
-- gatilho stamp_field_review_field_hash (UPDATE OF cycle_no).
CREATE OR REPLACE FUNCTION public.reconcile_auto_review_cycles(
  p_groups JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_group JSONB;
  v_human public.responses%ROWTYPE;
  v_llm public.responses%ROWTYPE;
  v_field_names TEXT[];
  v_divergent TEXT[];
  v_created INTEGER := 0;
  v_superseded INTEGER := 0;
  v_unchanged INTEGER := 0;
  v_count INTEGER;
  v_created_in_group INTEGER;
  v_current_equivalence_ids JSONB;
  v_project_pydantic_hash TEXT;
  v_project_fields JSONB;
BEGIN
  IF p_groups IS NULL OR pg_catalog.jsonb_typeof(p_groups) <> 'array' THEN
    RAISE EXCEPTION 'p_groups must be a JSON array';
  END IF;

  FOR v_group IN
    SELECT item
    FROM pg_catalog.jsonb_array_elements(p_groups) AS items(item)
    ORDER BY item->>'human_response_id', item->>'llm_response_id'
  LOOP
    v_created_in_group := 0;

    SELECT * INTO v_human
    FROM public.responses
    WHERE id = (v_group->>'human_response_id')::UUID
    FOR UPDATE;

    SELECT * INTO v_llm
    FROM public.responses
    WHERE id = (v_group->>'llm_response_id')::UUID
    FOR UPDATE;

    IF v_human.id IS NULL
       OR v_llm.id IS NULL
       OR v_human.respondent_type <> 'humano'
       OR v_llm.respondent_type <> 'llm'
       OR v_human.respondent_id IS NULL
       OR v_human.is_latest IS DISTINCT FROM true
       OR v_llm.is_latest IS DISTINCT FROM true
       OR v_human.project_id IS DISTINCT FROM v_llm.project_id
       OR v_human.document_id IS DISTINCT FROM v_llm.document_id THEN
      RAISE EXCEPTION 'auto-review responses must be current human/LLM rows from the same project and document';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        v_human.project_id::TEXT || ':' || v_human.document_id::TEXT,
        0
      )
    );

    SELECT COALESCE(pg_catalog.array_agg(DISTINCT name ORDER BY name), ARRAY[]::TEXT[])
    INTO v_field_names
    FROM pg_catalog.jsonb_array_elements_text(
      COALESCE(v_group->'field_names', '[]'::JSONB)
    ) AS names(name);

    SELECT COALESCE(pg_catalog.array_agg(DISTINCT name ORDER BY name), ARRAY[]::TEXT[])
    INTO v_divergent
    FROM pg_catalog.jsonb_array_elements_text(
      COALESCE(v_group->'divergent_field_names', '[]'::JSONB)
    ) AS names(name);

    IF EXISTS (
      SELECT 1 FROM pg_catalog.unnest(v_divergent) AS divergent(name)
      WHERE NOT (divergent.name = ANY(v_field_names))
    ) THEN
      RAISE EXCEPTION 'divergent fields must be a subset of field_names';
    END IF;

    IF NOT (
      v_group ? 'expected_human_updated_at'
      AND v_group ? 'expected_llm_updated_at'
      AND v_group ? 'expected_project_pydantic_hash'
      AND v_group ? 'expected_equivalence_ids'
    ) THEN
      RAISE EXCEPTION 'auto-review reconciliation requires versioned inputs';
    END IF;

    SELECT project.pydantic_hash, project.pydantic_fields
    INTO v_project_pydantic_hash, v_project_fields
    FROM public.projects AS project
    WHERE project.id = v_human.project_id;

    SELECT COALESCE(
      pg_catalog.jsonb_agg(locked.id::TEXT ORDER BY locked.id),
      '[]'::JSONB
    )
    INTO v_current_equivalence_ids
    FROM (
      SELECT equivalence.id
      FROM public.response_equivalences AS equivalence
      WHERE equivalence.project_id = v_human.project_id
        AND equivalence.document_id = v_human.document_id
        AND equivalence.field_name = ANY(v_field_names)
        AND equivalence.superseded_at IS NULL
        AND (
          (
            equivalence.response_a_id = v_human.id
            AND equivalence.response_b_id = v_llm.id
          )
          OR (
            equivalence.response_a_id = v_llm.id
            AND equivalence.response_b_id = v_human.id
          )
        )
      ORDER BY equivalence.id
      FOR SHARE
    ) AS locked;

    IF v_human.updated_at IS DISTINCT FROM
         (v_group->>'expected_human_updated_at')::TIMESTAMPTZ
       OR v_llm.updated_at IS DISTINCT FROM
         (v_group->>'expected_llm_updated_at')::TIMESTAMPTZ
       OR v_project_pydantic_hash IS DISTINCT FROM
         v_group->>'expected_project_pydantic_hash'
       OR v_current_equivalence_ids IS DISTINCT FROM
         COALESCE(v_group->'expected_equivalence_ids', '[]'::JSONB) THEN
      RAISE EXCEPTION 'auto-review reconciliation inputs changed; retry required';
    END IF;

    DELETE FROM public.response_equivalences AS equivalence
    WHERE equivalence.project_id = v_human.project_id
      AND equivalence.document_id = v_human.document_id
      AND (
        (
          equivalence.response_a_id = v_human.id
          AND equivalence.response_a_answer_snapshot IS DISTINCT FROM
            v_human.answers -> equivalence.field_name
        )
        OR (
          equivalence.response_b_id = v_human.id
          AND equivalence.response_b_answer_snapshot IS DISTINCT FROM
            v_human.answers -> equivalence.field_name
        )
        OR (
          equivalence.response_a_id = v_llm.id
          AND equivalence.response_a_answer_snapshot IS DISTINCT FROM
            v_llm.answers -> equivalence.field_name
        )
        OR (
          equivalence.response_b_id = v_llm.id
          AND equivalence.response_b_answer_snapshot IS DISTINCT FROM
            v_llm.answers -> equivalence.field_name
        )
      );

    WITH changed AS (
      UPDATE public.field_reviews AS review
      SET superseded_at = pg_catalog.now(),
          superseded_reason = CASE
            WHEN public.pydantic_field_by_name(v_project_fields, review.field_name) IS NULL
            THEN 'field_removed'
            WHEN NOT (review.field_name = ANY(v_divergent))
            THEN 'no_longer_divergent'
            WHEN review.human_response_id <> v_human.id
              OR review.human_answer_snapshot IS DISTINCT FROM
                 v_human.answers -> review.field_name
            THEN 'answer_changed'
            WHEN review.llm_response_id <> v_llm.id
              OR review.llm_answer_snapshot IS DISTINCT FROM
                 v_llm.answers -> review.field_name
              OR review.llm_justification_snapshot IS DISTINCT FROM
                 v_llm.justifications -> review.field_name
            THEN 'llm_changed'
            ELSE 'question_changed'
          END
      WHERE review.project_id = v_human.project_id
        AND review.document_id = v_human.document_id
        AND review.self_reviewer_id = v_human.respondent_id
        AND review.superseded_at IS NULL
        AND (
          NOT (review.field_name = ANY(v_divergent))
          OR review.human_response_id <> v_human.id
          OR review.llm_response_id <> v_llm.id
          OR review.human_answer_snapshot IS DISTINCT FROM
             v_human.answers -> review.field_name
          OR review.llm_answer_snapshot IS DISTINCT FROM
             v_llm.answers -> review.field_name
          OR review.llm_justification_snapshot IS DISTINCT FROM
             v_llm.justifications -> review.field_name
          OR NOT public.field_review_question_current(
            review.field_hash,
            public.pydantic_field_by_name(v_project_fields, review.field_name)
          )
        )
      RETURNING 1
    )
    SELECT count(*)::INTEGER INTO v_count FROM changed;
    v_superseded := v_superseded + v_count;

    INSERT INTO public.field_review_cycle_history_entries
    SELECT review.*
    FROM public.field_reviews AS review
    WHERE review.project_id = v_human.project_id
      AND review.document_id = v_human.document_id
      AND review.self_reviewer_id = v_human.respondent_id
      AND review.superseded_at IS NOT NULL
      AND review.field_name = ANY(v_divergent)
    ON CONFLICT (id) DO NOTHING;

    DELETE FROM public.field_reviews AS review
    WHERE review.project_id = v_human.project_id
      AND review.document_id = v_human.document_id
      AND review.self_reviewer_id = v_human.respondent_id
      AND review.superseded_at IS NOT NULL
      AND NOT (review.field_name = ANY(v_divergent));

    UPDATE public.field_reviews AS review
    SET id = pg_catalog.gen_random_uuid(),
        human_response_id = v_human.id,
        llm_response_id = v_llm.id,
        cycle_no = review.cycle_no + 1,
        human_answer_snapshot = v_human.answers -> review.field_name,
        llm_answer_snapshot = v_llm.answers -> review.field_name,
        llm_justification_snapshot = v_llm.justifications -> review.field_name,
        snapshot_reliable = true,
        self_verdict = NULL,
        self_reviewed_at = NULL,
        self_justification = NULL,
        arbitrator_id = NULL,
        blind_verdict = NULL,
        blind_decided_at = NULL,
        final_verdict = NULL,
        final_decided_at = NULL,
        question_improvement_suggestion = NULL,
        arbitrator_comment = NULL,
        created_at = pg_catalog.now(),
        superseded_at = NULL,
        superseded_reason = NULL
    WHERE review.project_id = v_human.project_id
      AND review.document_id = v_human.document_id
      AND review.self_reviewer_id = v_human.respondent_id
      AND review.superseded_at IS NOT NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_created_in_group := v_created_in_group + v_count;
    v_created := v_created + v_count;

    WITH candidates AS (
      SELECT field_name
      FROM pg_catalog.unnest(v_divergent) AS fields(field_name)
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.field_reviews AS current_review
        WHERE current_review.document_id = v_human.document_id
          AND current_review.field_name = fields.field_name
          AND current_review.superseded_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.field_reviews AS first_review
        WHERE first_review.document_id = v_human.document_id
          AND first_review.field_name = fields.field_name
          AND first_review.self_reviewer_id <> v_human.respondent_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.field_review_cycle_history_entries AS first_review
        WHERE first_review.document_id = v_human.document_id
          AND first_review.field_name = fields.field_name
          AND first_review.self_reviewer_id <> v_human.respondent_id
          AND NOT EXISTS (
            SELECT 1
            FROM public.member_email_links AS alias
            WHERE alias.project_id = v_human.project_id
              AND alias.member_user_id = v_human.respondent_id
              AND alias.linked_user_id = first_review.self_reviewer_id
          )
      )
    ), inserted AS (
      INSERT INTO public.field_reviews (
        project_id,
        document_id,
        field_name,
        human_response_id,
        llm_response_id,
        self_reviewer_id
      )
      SELECT
        v_human.project_id,
        v_human.document_id,
        candidate.field_name,
        v_human.id,
        v_llm.id,
        v_human.respondent_id
      FROM candidates AS candidate
      ON CONFLICT (document_id, field_name) DO NOTHING
      RETURNING 1
    )
    SELECT count(*)::INTEGER INTO v_count FROM inserted;
    v_created_in_group := v_created_in_group + v_count;
    v_created := v_created + v_count;

    SELECT count(*)::INTEGER INTO v_count
    FROM public.field_reviews AS review
    WHERE review.project_id = v_human.project_id
      AND review.document_id = v_human.document_id
      AND review.self_reviewer_id = v_human.respondent_id
      AND review.superseded_at IS NULL
      AND review.field_name = ANY(v_divergent);
    v_unchanged := v_unchanged + GREATEST(v_count - v_created_in_group, 0);

    -- Temporary compatibility projection for the frontend deployed before this
    -- migration.  The cycle-aware frontend does not read this assignment.
    INSERT INTO public.assignments (
      project_id, document_id, user_id, type, status
    )
    SELECT
      v_human.project_id,
      v_human.document_id,
      v_human.respondent_id,
      'auto_revisao',
      'pendente'
    WHERE EXISTS (
      SELECT 1
      FROM public.field_reviews AS review
      WHERE review.project_id = v_human.project_id
        AND review.document_id = v_human.document_id
        AND review.self_reviewer_id = v_human.respondent_id
        AND review.superseded_at IS NULL
        AND review.self_verdict IS NULL
    )
    ON CONFLICT (document_id, user_id, type, round_id) DO UPDATE
    SET status = 'pendente', completed_at = NULL;

    UPDATE public.assignments AS assignment
    SET status = 'concluido', completed_at = pg_catalog.now()
    WHERE assignment.project_id = v_human.project_id
      AND assignment.document_id = v_human.document_id
      AND assignment.user_id = v_human.respondent_id
      AND assignment.type = 'auto_revisao'
      AND NOT EXISTS (
        SELECT 1
        FROM public.field_reviews AS review
        WHERE review.project_id = assignment.project_id
          AND review.document_id = assignment.document_id
          AND review.self_reviewer_id = assignment.user_id
          AND review.superseded_at IS NULL
          AND review.self_verdict IS NULL
      );

    DELETE FROM public.assignments AS assignment
    WHERE assignment.project_id = v_human.project_id
      AND assignment.document_id = v_human.document_id
      AND assignment.type = 'arbitragem'
      AND assignment.status <> 'concluido'
      AND NOT EXISTS (
        SELECT 1
        FROM public.field_reviews AS review
        WHERE review.project_id = assignment.project_id
          AND review.document_id = assignment.document_id
          AND review.arbitrator_id = assignment.user_id
          AND review.superseded_at IS NULL
          AND review.final_verdict IS NULL
      );
  END LOOP;

  RETURN pg_catalog.jsonb_build_object(
    'created', v_created,
    'superseded', v_superseded,
    'unchanged', v_unchanged
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_auto_review_cycles(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_auto_review_cycles(JSONB)
  TO service_role;


-- ── Par "=": so entre respostas dadas a versao atual da pergunta ────────────
-- Copia SQL de `answersCurrentQuestion` (frontend/src/lib/answer-staleness.ts),
-- com a mesma matriz de casos nos testes. So o hash gravado na resposta prova
-- a versao; sem hash do campo (mapa NULL ou `{}`, chave ausente ou nula) a
-- ausencia nao invalida sozinha. Campo fora do schema reprova, e campo atual
-- sem hash com resposta carimbada tambem.
CREATE FUNCTION public.response_answers_current_question(p_answer_field_hashes JSONB, p_field JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT COALESCE(
    pg_catalog.jsonb_typeof(p_field) = 'object'
      AND (pg_catalog.jsonb_typeof(p_answer_field_hashes -> (p_field->>'name')) IS DISTINCT FROM 'string'
           OR (p_answer_field_hashes ->> (p_field->>'name')) = (p_field->>'hash')),
    false);
$$;

REVOKE ALL ON FUNCTION public.response_answers_current_question(JSONB, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.response_answers_current_question(JSONB, JSONB) TO service_role;

-- Corpo de 20260717120000 com a guarda da versao da pergunta depois da de
-- permissao.
CREATE OR REPLACE FUNCTION public.record_response_equivalences(p_rows JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_inserted INTEGER;
BEGIN
  IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'p_rows must be a JSON array';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      documents.project_id || ':' || documents.document_id,
      0
    )
  )
  FROM (
    SELECT DISTINCT
      item->>'project_id' AS project_id,
      item->>'document_id' AS document_id
    FROM pg_catalog.jsonb_array_elements(p_rows) AS rows(item)
    ORDER BY project_id, document_id
  ) AS documents;

  IF SESSION_USER <> 'postgres'
     AND auth.role() IS DISTINCT FROM 'service_role'
     AND EXISTS (
       SELECT 1
       FROM pg_catalog.jsonb_array_elements(p_rows) AS rows(row)
       WHERE NOT (
         (
           (row->>'reviewer_id')::UUID IN (
             SELECT public.auth_user_member_identity_ids(
               (row->>'project_id')::UUID
             )
           )
           AND (row->>'project_id')::UUID IN (
             SELECT public.auth_user_accessible_project_ids()
           )
         )
         OR (row->>'project_id')::UUID IN (
           SELECT public.auth_user_coordinator_project_ids()
         )
         OR (row->>'project_id')::UUID IN (
           SELECT project.id
           FROM public.projects AS project
           WHERE project.created_by = public.clerk_uid()
         )
         OR public.is_master()
       )
     ) THEN
    RAISE EXCEPTION 'not allowed to record equivalences for this reviewer/project';
  END IF;

  -- O par e uma decisao sobre dois valores respondidos para UMA versao da
  -- pergunta: as duas respostas precisam ter sido dadas a versao atual
  -- (`response_answers_current_question`, a regra de leitura de
  -- `filterCurrentEquivalencePairs`). A rodada nao entra: resposta de rodada
  -- anterior fica congelada e pode ser parte do par. Sem esta guarda o par de
  -- outra versao era gravado, a acao reportava sucesso e a leitura nunca o
  -- usava.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_rows) AS rows(row)
    LEFT JOIN public.projects AS project
      ON project.id = (row->>'project_id')::UUID
    LEFT JOIN public.responses AS response_a
      ON response_a.id = (row->>'response_a_id')::UUID
    LEFT JOIN public.responses AS response_b
      ON response_b.id = (row->>'response_b_id')::UUID
    CROSS JOIN LATERAL (
      SELECT public.pydantic_field_by_name(project.pydantic_fields, row->>'field_name') AS value
    ) AS field
    WHERE NOT public.response_answers_current_question(response_a.answer_field_hashes, field.value)
       OR NOT public.response_answers_current_question(response_b.answer_field_hashes, field.value)
  ) THEN
    RAISE EXCEPTION 'Uma das respostas foi dada a outra versão da pergunta e não pode ser marcada como equivalente. Só respostas à versão atual da pergunta podem ser fundidas com "=".'
      USING ERRCODE = '23514';
  END IF;

  -- A previous decision for the same response IDs may refer to older mutable
  -- values. DELETE is the single archive boundary for operational rows.
  DELETE FROM public.response_equivalences AS equivalence
  USING pg_catalog.jsonb_array_elements(p_rows) AS rows(row),
        public.responses AS response_a,
        public.responses AS response_b
  WHERE equivalence.project_id = (row->>'project_id')::UUID
    AND equivalence.document_id = (row->>'document_id')::UUID
    AND equivalence.field_name = row->>'field_name'
    AND equivalence.response_a_id = (row->>'response_a_id')::UUID
    AND equivalence.response_b_id = (row->>'response_b_id')::UUID
    AND response_a.id = equivalence.response_a_id
    AND response_b.id = equivalence.response_b_id
    AND (
      equivalence.response_a_answer_snapshot IS DISTINCT FROM
        response_a.answers -> equivalence.field_name
      OR equivalence.response_b_answer_snapshot IS DISTINCT FROM
        response_b.answers -> equivalence.field_name
    );

  WITH inserted AS (
    INSERT INTO public.response_equivalences (
      project_id,
      document_id,
      field_name,
      response_a_id,
      response_b_id,
      reviewer_id
    )
    SELECT
      (row->>'project_id')::UUID,
      (row->>'document_id')::UUID,
      row->>'field_name',
      (row->>'response_a_id')::UUID,
      (row->>'response_b_id')::UUID,
      (row->>'reviewer_id')::UUID
    FROM pg_catalog.jsonb_array_elements(p_rows) AS rows(row)
    ON CONFLICT (
      project_id,
      document_id,
      field_name,
      response_a_id,
      response_b_id
    ) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::INTEGER INTO v_inserted FROM inserted;

  RETURN v_inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.record_response_equivalences(JSONB)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_response_equivalences(JSONB)
  TO authenticated, service_role;


-- ── Decisao do LLM Insights: toda resposta humana da celula ─────────────────
-- Hash das respostas humanas vigentes do documento no campo: id, presenca,
-- valor e hash do campo. Nova resposta humana, resposta que deixou de ser
-- vigente e edicao do campo por qualquer codificador mudam o hash. Chamada
-- por llm_error_context (DEFINER) e pelo backfill abaixo; fechada para os
-- clientes.
CREATE FUNCTION public.error_resolution_cell_answers_hash(
  p_project_id UUID, p_document_id UUID, p_field_name TEXT
) RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', human.id,
      'present', human.answers ? p_field_name,
      'value', human.answers -> p_field_name,
      'field_hash', human.answer_field_hashes -> p_field_name
    ) ORDER BY human.id), '[]'::JSONB)::TEXT,
    'UTF8')), 'hex')
  FROM public.responses AS human
  WHERE human.project_id = p_project_id
    AND human.document_id = p_document_id
    AND human.respondent_type = 'humano'
    AND human.is_latest;
$$;

REVOKE ALL ON FUNCTION public.error_resolution_cell_answers_hash(UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

-- Corpo de 20260926121000 com duas mudancas: a fonte de auto-revisao exige o
-- ciclo valido, e `source` ganha `cell_answers_hash`. Mesma assinatura e mesmo
-- default: os grants continuam os de la.
CREATE OR REPLACE FUNCTION public.llm_error_context(
  p_project_id UUID, p_document_id UUID, p_field_name TEXT,
  p_llm_response_id UUID, p_human_response_id UUID, p_source_kind TEXT, p_source_id UUID,
  p_require_valid_source BOOLEAN DEFAULT true
) RETURNS JSONB
-- A validade de uma decisão concluída não depende de quem participou da arbitragem.
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_project public.projects%ROWTYPE;
  v_llm public.responses%ROWTYPE;
  v_human public.responses%ROWTYPE;
  v_review public.reviews%ROWTYPE;
  v_self public.field_reviews%ROWTYPE;
  v_field JSONB;
  v_source JSONB;
  v_llm_value JSONB;
  v_human_value JSONB;
BEGIN
  IF public.clerk_uid() IS NULL OR NOT COALESCE((
    p_project_id IN (SELECT public.auth_user_project_ids())
    OR p_project_id IN (SELECT public.auth_user_coordinator_or_creator_project_ids()) OR public.is_master()
  ), false) THEN RETURN NULL; END IF;
  SELECT * INTO v_project FROM public.projects WHERE id = p_project_id;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.documents WHERE id = p_document_id AND project_id = p_project_id
      AND excluded_at IS NULL AND exclusion_pending_at IS NULL
  ) THEN RETURN NULL; END IF;
  SELECT field INTO v_field FROM pg_catalog.jsonb_array_elements(v_project.pydantic_fields) AS field
    WHERE field->>'name' = p_field_name;
  IF v_field IS NULL OR COALESCE(v_field->>'target', 'all') <> 'all' THEN RETURN NULL; END IF;

  SELECT * INTO v_llm FROM public.responses WHERE id = p_llm_response_id
    AND project_id = p_project_id AND document_id = p_document_id
    AND respondent_type = 'llm' AND is_latest
    AND round_id IS NOT DISTINCT FROM v_project.current_round_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO v_human FROM public.responses WHERE id = p_human_response_id
    AND project_id = p_project_id AND document_id = p_document_id
    AND respondent_type = 'humano' AND is_latest
    AND round_id IS NOT DISTINCT FROM v_project.current_round_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_llm_value := v_llm.answers->p_field_name;
  v_human_value := v_human.answers->p_field_name;

  IF p_source_kind = 'comparacao' THEN
    SELECT * INTO v_review FROM public.reviews WHERE id = p_source_id
      AND project_id = p_project_id AND document_id = p_document_id AND field_name = p_field_name;
    IF NOT FOUND THEN RETURN NULL; END IF;
    -- Veredito dado sobre outra versao da pergunta, ou fora do dominio atual.
    IF p_require_valid_source AND NOT public.review_is_valid(v_review.id) THEN RETURN NULL; END IF;
    v_source := pg_catalog.jsonb_build_object('kind', p_source_kind, 'id', v_review.id,
      'verdict', v_review.verdict, 'chosen_response_id', v_review.chosen_response_id,
      'response_snapshot', v_review.response_snapshot, 'comment', v_review.comment);
  ELSIF p_source_kind = 'auto_revisao' AND v_project.automation_mode = 'auto_review_llm' THEN
    SELECT * INTO v_self FROM public.field_reviews WHERE id = p_source_id
      AND project_id = p_project_id AND document_id = p_document_id AND field_name = p_field_name
      AND human_response_id = v_human.id AND llm_response_id = v_llm.id AND superseded_at IS NULL;
    IF NOT FOUND OR v_self.final_verdict IS NULL OR
      public.is_auto_review_reconciliation_pending(p_project_id, p_document_id, v_llm.id)
      OR v_self.llm_answer_snapshot IS DISTINCT FROM v_llm_value
      OR v_self.human_answer_snapshot IS DISTINCT FROM v_human_value
      -- Auto-revisao aberta sobre outra versao da pergunta nao e fonte.
      OR NOT public.field_review_question_current(v_self.field_hash, v_field)
    THEN RETURN NULL; END IF;
    v_llm_value := v_self.llm_answer_snapshot;
    v_human_value := v_self.human_answer_snapshot;
    v_source := pg_catalog.jsonb_build_object('kind', p_source_kind, 'id', v_self.id,
      'cycle_no', v_self.cycle_no, 'self_verdict', v_self.self_verdict,
      'final_verdict', v_self.final_verdict, 'final_decided_at', v_self.final_decided_at,
      'arbitrator_comment', v_self.arbitrator_comment);
  ELSE RETURN NULL;
  END IF;

  -- O hash cobre condicionantes sem repetir a resposta inteira em cada decisão de campo.
  v_source := v_source || pg_catalog.jsonb_build_object(
    'responses_hash', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_object('llm', v_llm.answers, 'human', v_human.answers,
        'llm_field_hashes', v_llm.answer_field_hashes, 'human_field_hashes', v_human.answer_field_hashes,
        'llm_justifications', v_llm.justifications, 'human_justifications', v_human.justifications)::TEXT,
      'UTF8')), 'hex'),
    'reviews', (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', r.id, 'verdict', r.verdict, 'chosen_response_id', r.chosen_response_id,
      'comment', r.comment, 'response_snapshot', r.response_snapshot) ORDER BY r.id), '[]'::JSONB)
      FROM public.reviews r WHERE r.project_id = p_project_id AND r.document_id = p_document_id AND r.field_name = p_field_name),
    'auto_reviews', (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', fr.id, 'cycle_no', fr.cycle_no, 'final_verdict', fr.final_verdict,
      'final_decided_at', fr.final_decided_at) ORDER BY fr.id), '[]'::JSONB)
      FROM public.field_reviews fr WHERE fr.project_id = p_project_id AND fr.document_id = p_document_id
        AND fr.field_name = p_field_name AND fr.superseded_at IS NULL),
    -- Toda resposta humana vigente da celula, e nao so a do contexto: editar
    -- a resposta de outro codificador tambem muda a celula que a decisao
    -- julgou.
    'cell_answers_hash', public.error_resolution_cell_answers_hash(p_project_id, p_document_id, p_field_name));
  RETURN pg_catalog.jsonb_build_object(
    'project_id', p_project_id, 'document_id', p_document_id, 'field_name', p_field_name,
    'round_id', v_project.current_round_id, 'automation_mode', v_project.automation_mode,
    'field_definition', v_field, 'llm_response_id', v_llm.id, 'human_response_id', v_human.id,
    'llm_value', pg_catalog.jsonb_build_object('present', v_llm.answers ? p_field_name, 'value', v_llm_value),
    'human_value', pg_catalog.jsonb_build_object('present', v_human.answers ? p_field_name, 'value', v_human_value),
    'source', v_source);
END $$;


-- Backfill: a chave nova entra no contexto recalculado de toda decisao, e sem
-- ela no contexto guardado toda decisao existente viraria "Fontes alteradas".
-- O hash guardado e o de agora: a edicao de outro codificador feita entre a
-- decisao e esta migration nao e detectada, porque nao ha registro do valor
-- de entao. Decisao ja stale por outro motivo continua stale. A funcao fica
-- no banco para o teste SQL exercitar o backfill que a migration roda (os
-- testes rodam depois das migrations e nao veem decisao anterior a ela), e so
-- preenche decisao sem a chave. Devolve quantas preencheu.
CREATE FUNCTION public.backfill_error_resolution_cell_answers_hash()
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_filled INTEGER;
BEGIN
  UPDATE public.error_resolutions AS resolution
  SET context = pg_catalog.jsonb_set(
    resolution.context, '{source,cell_answers_hash}',
    pg_catalog.to_jsonb(public.error_resolution_cell_answers_hash(
      resolution.project_id, resolution.document_id, resolution.field_name)))
  WHERE pg_catalog.jsonb_typeof(resolution.context->'source') = 'object'
    AND NOT (resolution.context->'source' ? 'cell_answers_hash');
  GET DIAGNOSTICS v_filled = ROW_COUNT;
  RETURN v_filled;
END;
$$;

REVOKE ALL ON FUNCTION public.backfill_error_resolution_cell_answers_hash()
  FROM PUBLIC, anon, authenticated, service_role;

DO $$
DECLARE
  v_filled INTEGER;
BEGIN
  v_filled := public.backfill_error_resolution_cell_answers_hash();
  -- Nenhuma decisao com contexto pode sair desta migration sem a chave.
  IF EXISTS (
    SELECT 1 FROM public.error_resolutions
    WHERE pg_catalog.jsonb_typeof(context->'source') = 'object'
      AND NOT (context->'source' ? 'cell_answers_hash')
  ) THEN
    RAISE EXCEPTION 'error_resolutions: decisao com contexto sem cell_answers_hash depois do backfill';
  END IF;
  RAISE NOTICE 'error_resolutions: cell_answers_hash gravado em % decisao(oes)', v_filled;
END $$;

COMMIT;
