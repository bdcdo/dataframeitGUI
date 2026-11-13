-- Equivalencia "=" passa a valer por VALOR, dentro da versao da pergunta.
--
-- Ate aqui o "=" (`response_equivalences`) ligava duas RESPOSTAS: o gatilho
-- archive_review_dependencies_on_response_change o apagava quando uma delas
-- mudava ou deixava de ser `is_latest`, entao publicar uma execucao nova do
-- LLM apagava todas as equivalencias do projeto (no "Zolgensma - Notas SP, DF,
-- RJ", ~310 pares), mesmo quando o LLM reproduzia os mesmos valores.
--
-- Regra nova: "no campo X, na versao da pergunta com hash H, o valor A
-- equivale ao valor B" (`value_equivalences`). A equivalencia:
--   * nao depende de resposta: sobrevive a execucao nova do LLM e a
--     recodificacao que reproduz os mesmos valores;
--   * vale para o projeto inteiro naquele campo, com fechamento transitivo
--     (A=B e B=C fundem A, B e C), calculado no TS por union-find;
--   * cai so quando a pergunta muda (hash do campo diferente, campo removido
--     ou renomeado): o save do schema a leva ao historico
--     (archive_question_changed_field_reviews, abaixo). O hash e o de
--     `computeFieldHash` (nome, tipo, opcoes, enunciado e `question_revision`);
--     o `help_text` nao entra, como em todo julgamento preso a versao;
--   * desfazer nao apaga veredito nenhum: muda o agrupamento daqui em diante.
--     Isto substitui, para a equivalencia de valor, a regra do #545
--     (remove_response_equivalence apagava o veredito do dono e de quem
--     desfazia): no projeto inteiro ela apagaria votos validos em centenas de
--     documentos, e o voto num valor continua valido depois da separacao.
--
-- Normalizacao: a mesma de "mesma resposta" da Comparacao
-- (`normalizeForComparison`: sem acento, caixa, espacos colapsados e aparados;
-- listas elemento a elemento). Ela so existe no TS: o banco guarda o valor
-- BRUTO julgado (tirado das respostas pelo proprio banco, nunca do cliente) e a
-- unicidade e pelo valor bruto. Duas linhas que so diferem na caixa sao
-- redundantes e inofensivas: o union-find as funde.
--
-- Escrita so por RPC SECURITY DEFINER (record_value_equivalences,
-- remove_value_equivalence e o veredito 'equivalente' de
-- submit_auto_review_verdicts). A tabela nao tem policy de escrita, mais
-- estrito que o `FOR ALL` de response_equivalences.
--
-- `response_equivalences` fica congelada: o backfill abaixo a copia e marca o
-- par copiado como superado ('migrated_to_value'), nenhum codigo novo a le ou
-- escreve, e a migration que a remove (junto do bloco no gatilho de resposta e
-- das RPCs antigas) vem depois do deploy, repetindo o backfill, que entao so
-- ve os pares gravados pelo codigo antigo na janela.
--
-- Ordem de deploy: aplicar e mesclar em seguida. O reconciliador antigo manda
-- em `expected_equivalence_ids` os pares de resposta, e a funcao nova compara
-- com as equivalencias de valor: na janela, os pedidos de reconciliacao falham
-- com "inputs changed; retry required" e ficam na fila para o worker novo.

BEGIN;

-- ── Tabela ───────────────────────────────────────────────────────────────────
CREATE TABLE public.value_equivalences (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  field_name         TEXT NOT NULL,
  -- Hash do campo quando a equivalencia foi decidida. Vale enquanto for o
  -- hash atual do campo no schema do projeto.
  field_hash         TEXT NOT NULL,
  -- Par canonico (value_a < value_b, ordem do jsonb), valores brutos julgados.
  value_a            JSONB NOT NULL,
  value_b            JSONB NOT NULL,
  reviewer_id        UUID REFERENCES public.profiles(id),
  source             TEXT NOT NULL,
  -- Documento em que a decisao foi tomada: so auditoria, nao escopo.
  origin_document_id UUID REFERENCES public.documents(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Sempre NULL na tabela operacional; preenchidos so no instante do DELETE
  -- que leva a linha ao historico, com o motivo.
  superseded_at      TIMESTAMPTZ,
  superseded_reason  TEXT,
  CONSTRAINT value_equivalences_canonical_order CHECK (value_a < value_b),
  CONSTRAINT value_equivalences_source_check CHECK (
    source IN ('comparacao', 'llm_insights', 'auto_revisao', 'migracao')
  ),
  CONSTRAINT value_equivalences_superseded_reason_check CHECK (
    superseded_reason IS NULL OR superseded_reason IN (
      'manually_removed', 'question_changed', 'field_removed'
    )
  )
);

-- Unicidade pelo md5 do valor: texto livre de alguns KB nao cabe numa entrada
-- de btree. O prefixo (project_id, field_name, field_hash) serve a leitura por
-- projeto e a policy, sem indice separado.
CREATE UNIQUE INDEX value_equivalences_unique_pair
  ON public.value_equivalences (
    project_id, field_name, field_hash, md5(value_a::TEXT), md5(value_b::TEXT)
  );

ALTER TABLE public.value_equivalences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members view value_equivalences"
  ON public.value_equivalences
  FOR SELECT
  USING (
    project_id IN (
      SELECT accessible.project_id
      FROM public.auth_user_accessible_project_ids() AS accessible(project_id)
    )
    OR (SELECT public.is_master())
  );

REVOKE ALL ON public.value_equivalences FROM anon;

-- As leituras por valor (documentos afetados por uma equivalencia, "onde se
-- aplica") varrem as respostas vigentes do projeto paginando por id.
CREATE INDEX IF NOT EXISTS idx_responses_project_latest_id
  ON public.responses (project_id, id)
  WHERE is_latest;

-- ── Historico ────────────────────────────────────────────────────────────────
CREATE TABLE public.value_equivalence_history_entries (
  id                 UUID PRIMARY KEY,
  project_id         UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  field_name         TEXT NOT NULL,
  field_hash         TEXT NOT NULL,
  value_a            JSONB NOT NULL,
  value_b            JSONB NOT NULL,
  reviewer_id        UUID,
  source             TEXT NOT NULL,
  origin_document_id UUID,
  created_at         TIMESTAMPTZ NOT NULL,
  superseded_at      TIMESTAMPTZ NOT NULL,
  superseded_reason  TEXT NOT NULL,
  CONSTRAINT value_equivalence_history_reason_check CHECK (
    superseded_reason IN ('manually_removed', 'question_changed', 'field_removed')
  )
);

-- A aba lista o historico do projeto pelo mais recente.
CREATE INDEX idx_value_equivalence_history_project_recent
  ON public.value_equivalence_history_entries (project_id, superseded_at DESC);

ALTER TABLE public.value_equivalence_history_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members view value equivalence history"
  ON public.value_equivalence_history_entries
  FOR SELECT
  USING (
    project_id IN (
      SELECT accessible.project_id
      FROM public.auth_user_accessible_project_ids() AS accessible(project_id)
    )
    OR (SELECT public.is_master())
  );

REVOKE ALL ON public.value_equivalence_history_entries FROM anon;

-- Arquiva no DELETE, com a guarda de 20260724100000: no cascade do projeto a
-- ancora ja saiu e a linha de historico seria apagada pela mesma FK.
CREATE FUNCTION public.archive_value_equivalence_before_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.projects WHERE id = OLD.project_id) THEN
    RETURN OLD;
  END IF;

  INSERT INTO public.value_equivalence_history_entries (
    id, project_id, field_name, field_hash, value_a, value_b, reviewer_id,
    source, origin_document_id, created_at, superseded_at, superseded_reason
  ) VALUES (
    OLD.id, OLD.project_id, OLD.field_name, OLD.field_hash, OLD.value_a,
    OLD.value_b, OLD.reviewer_id, OLD.source, OLD.origin_document_id,
    OLD.created_at, COALESCE(OLD.superseded_at, pg_catalog.now()),
    COALESCE(OLD.superseded_reason, 'manually_removed')
  ) ON CONFLICT (id) DO NOTHING;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.archive_value_equivalence_before_delete()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER archive_value_equivalence_before_delete
BEFORE DELETE ON public.value_equivalences
FOR EACH ROW EXECUTE FUNCTION public.archive_value_equivalence_before_delete();

-- ── Gravar ───────────────────────────────────────────────────────────────────
-- Entrada: as respostas cujas respostas o revisor fundiu, como no par antigo
-- ({project_id, document_id, field_name, response_a_id, response_b_id,
-- reviewer_id, source}). Os VALORES saem das respostas, e o hash, do schema
-- atual: o cliente nao escolhe nem um nem outro. As duas respostas precisam
-- ter sido dadas a versao atual da pergunta (`response_answers_current_question`,
-- a regra de leitura do TS). Valores identicos nao gravam nada. Devolve as
-- equivalencias novas (campo e valores), que a action propaga aos outros
-- documentos sem reler as respostas.
CREATE FUNCTION public.record_value_equivalences(p_rows JSONB)
RETURNS TABLE(field_name TEXT, value_a JSONB, value_b JSONB)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
-- As colunas de saida tem os nomes das colunas da tabela.
#variable_conflict use_column
BEGIN
  IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'p_rows must be a JSON array';
  END IF;

  -- Mesma autoridade de record_response_equivalences: a identidade de
  -- trabalho do revisor no projeto, ou coordenacao, criadora ou master.
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

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_rows) AS rows(row)
    WHERE row->>'source' IS NULL
       OR row->>'source' NOT IN ('comparacao', 'llm_insights')
  ) THEN
    RAISE EXCEPTION 'invalid equivalence source';
  END IF;

  -- Serializa as escritas no mesmo (projeto, campo).
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'value_equivalence:' || cells.project_id || ':' || cells.field_name,
      0
    )
  )
  FROM (
    SELECT DISTINCT
      row->>'project_id' AS project_id,
      row->>'field_name' AS field_name
    FROM pg_catalog.jsonb_array_elements(p_rows) AS rows(row)
    ORDER BY project_id, field_name
  ) AS cells;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_rows) AS rows(row)
    LEFT JOIN public.responses AS response_a
      ON response_a.id = (row->>'response_a_id')::UUID
    LEFT JOIN public.responses AS response_b
      ON response_b.id = (row->>'response_b_id')::UUID
    WHERE response_a.id IS NULL
       OR response_b.id IS NULL
       OR response_a.project_id IS DISTINCT FROM (row->>'project_id')::UUID
       OR response_b.project_id IS DISTINCT FROM (row->>'project_id')::UUID
       OR response_a.document_id IS DISTINCT FROM (row->>'document_id')::UUID
       OR response_b.document_id IS DISTINCT FROM (row->>'document_id')::UUID
       OR NOT (response_a.answers ? (row->>'field_name'))
       OR NOT (response_b.answers ? (row->>'field_name'))
  ) THEN
    RAISE EXCEPTION 'equivalence responses must belong to the declared project and document and answer the field';
  END IF;

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
    WHERE field.value ->> 'hash' IS NULL
       OR NOT public.response_answers_current_question(response_a.answer_field_hashes, field.value)
       OR NOT public.response_answers_current_question(response_b.answer_field_hashes, field.value)
  ) THEN
    RAISE EXCEPTION 'Uma das respostas foi dada a outra versão da pergunta e não pode ser marcada como equivalente. Só respostas à versão atual da pergunta podem ser fundidas com "=".'
      USING ERRCODE = '23514';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT DISTINCT ON (
      project.id, field.name,
      LEAST(response_a.answers -> field.name, response_b.answers -> field.name),
      GREATEST(response_a.answers -> field.name, response_b.answers -> field.name)
    )
      project.id AS project_id,
      field.name AS field_name,
      field.hash AS field_hash,
      LEAST(response_a.answers -> field.name, response_b.answers -> field.name) AS value_a,
      GREATEST(response_a.answers -> field.name, response_b.answers -> field.name) AS value_b,
      (row->>'reviewer_id')::UUID AS reviewer_id,
      row->>'source' AS source,
      (row->>'document_id')::UUID AS origin_document_id
    FROM pg_catalog.jsonb_array_elements(p_rows) AS rows(row)
    JOIN public.projects AS project ON project.id = (row->>'project_id')::UUID
    JOIN public.responses AS response_a ON response_a.id = (row->>'response_a_id')::UUID
    JOIN public.responses AS response_b ON response_b.id = (row->>'response_b_id')::UUID
    CROSS JOIN LATERAL (
      SELECT
        row->>'field_name' AS name,
        public.pydantic_field_by_name(project.pydantic_fields, row->>'field_name') ->> 'hash' AS hash
    ) AS field
    WHERE (response_a.answers -> field.name) IS DISTINCT FROM (response_b.answers -> field.name)
  ),
  inserted AS (
    INSERT INTO public.value_equivalences (
      project_id, field_name, field_hash, value_a, value_b,
      reviewer_id, source, origin_document_id
    )
    SELECT
      candidates.project_id, candidates.field_name, candidates.field_hash,
      candidates.value_a, candidates.value_b, candidates.reviewer_id,
      candidates.source, candidates.origin_document_id
    FROM candidates
    ON CONFLICT (
      project_id, field_name, field_hash,
      (pg_catalog.md5(value_a::TEXT)), (pg_catalog.md5(value_b::TEXT))
    ) DO NOTHING
    RETURNING
      public.value_equivalences.field_name,
      public.value_equivalences.value_a,
      public.value_equivalences.value_b
  )
  SELECT inserted.field_name, inserted.value_a, inserted.value_b FROM inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.record_value_equivalences(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_value_equivalences(JSONB)
  TO authenticated, service_role;

-- ── Desfazer ─────────────────────────────────────────────────────────────────
-- Remove a equivalencia no projeto inteiro e a leva ao historico. Nao apaga
-- veredito: o voto num valor continua valido depois da separacao, e a
-- divergencia que reaparecer leva o documento de volta a fila pelo sync.
-- Autoridade: o dono pela identidade de trabalho (alias-aware), coordenacao,
-- criadora ou master, como remove_response_equivalence. Devolve o campo, o
-- hash e os valores separados, que a action propaga. Conjunto vazio quando a linha nao
-- existe ou a autoridade nao bate; a action trata os dois como falha.
CREATE FUNCTION public.remove_value_equivalence(
  p_project_id UUID,
  p_equivalence_id UUID
) RETURNS TABLE(field_name TEXT, field_hash TEXT, value_a JSONB, value_b JSONB)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
-- As colunas de saida tem os nomes das colunas da tabela.
#variable_conflict use_column
DECLARE
  v_removed public.value_equivalences%ROWTYPE;
BEGIN
  SELECT equivalence.*
  INTO v_removed
  FROM public.value_equivalences AS equivalence
  WHERE equivalence.id = p_equivalence_id
    AND equivalence.project_id = p_project_id
    AND (
      equivalence.reviewer_id IN (
        SELECT public.auth_user_member_identity_ids(p_project_id)
      )
      OR equivalence.project_id IN (
        SELECT public.auth_user_coordinator_or_creator_project_ids()
      )
      OR public.is_master()
    )
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- O gatilho de historico grava 'manually_removed' quando o motivo nao vem.
  DELETE FROM public.value_equivalences AS equivalence
  WHERE equivalence.id = p_equivalence_id;

  RETURN QUERY SELECT v_removed.field_name, v_removed.field_hash, v_removed.value_a, v_removed.value_b;
END;
$$;

REVOKE ALL ON FUNCTION public.remove_value_equivalence(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_value_equivalence(UUID, UUID)
  TO authenticated, service_role;

-- ── Reconciliacao dos documentos afetados ────────────────────────────────────
-- Criar ou desfazer uma equivalencia muda a divergencia em todo documento do
-- projeto que tem um dos valores, e so o TS sabe quais (a chave normalizada
-- vive la). A action manda a lista, e esta funcao os enfileira com o mesmo
-- pedido de enqueue_auto_review_reconciliation_for_project, restrito a eles.
-- Enfileirar e idempotente e so leva a um recalculo; por isso basta ser membro
-- do projeto.
CREATE FUNCTION public.enqueue_auto_review_reconciliation_for_documents(
  p_project_id UUID,
  p_document_ids UUID[]
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_enqueued INTEGER;
BEGIN
  IF SESSION_USER <> 'postgres'
     AND auth.role() IS DISTINCT FROM 'service_role'
     AND NOT (
       p_project_id IN (SELECT public.auth_user_accessible_project_ids())
       OR public.is_master()
     ) THEN
    RAISE EXCEPTION 'not allowed to enqueue reconciliation for this project';
  END IF;

  IF p_document_ids IS NULL OR pg_catalog.cardinality(p_document_ids) = 0 THEN
    RETURN 0;
  END IF;

  PERFORM 1
  FROM public.documents AS document
  WHERE document.project_id = p_project_id
    AND document.id = ANY(p_document_ids)
  ORDER BY document.id
  FOR UPDATE;

  INSERT INTO public.auto_review_reconciliation_requests (
    document_id, project_id, llm_response_id, allow_new_cycles
  )
  SELECT
    document.id,
    document.project_id,
    llm.id,
    project.automation_mode = 'auto_review_llm'
  FROM public.documents AS document
  JOIN public.projects AS project ON project.id = document.project_id
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
  WHERE document.project_id = p_project_id
    AND document.id = ANY(p_document_ids)
    AND EXISTS (
      SELECT 1
      FROM public.responses AS human
      WHERE human.project_id = document.project_id
        AND human.document_id = document.id
        AND human.respondent_type = 'humano'
        AND human.is_latest = true
        AND human.is_partial = false
    )
    AND (
      project.automation_mode = 'auto_review_llm'
      OR EXISTS (
        SELECT 1 FROM public.field_reviews AS review
        WHERE review.project_id = document.project_id
          AND review.document_id = document.id
      )
      OR EXISTS (
        SELECT 1 FROM public.field_review_cycle_history_entries AS history
        WHERE history.project_id = document.project_id
          AND history.document_id = document.id
      )
    )
  ON CONFLICT (document_id) DO UPDATE
  SET project_id = EXCLUDED.project_id,
      llm_response_id = EXCLUDED.llm_response_id,
      allow_new_cycles = EXCLUDED.allow_new_cycles,
      requested_at = pg_catalog.now(),
      next_attempt_at = pg_catalog.now(),
      attempt_count = 0,
      last_error = NULL;

  GET DIAGNOSTICS v_enqueued = ROW_COUNT;
  RETURN v_enqueued;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_auto_review_reconciliation_for_documents(UUID, UUID[])
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enqueue_auto_review_reconciliation_for_documents(UUID, UUID[])
  TO authenticated, service_role;

-- O par avaliado pelo backfill sai de cena com o motivo 'migrated_to_value'
-- (ver a funcao abaixo).
ALTER TABLE public.response_equivalences
  DROP CONSTRAINT response_equivalences_superseded_reason_check,
  ADD CONSTRAINT response_equivalences_superseded_reason_check CHECK (
    superseded_reason IS NULL OR superseded_reason IN (
      'answer_changed',
      'response_revised',
      'manually_removed',
      'legacy_response_changed',
      'migrated_to_value'
    )
  );

-- ── Backfill: pares de resposta viram pares de valor ─────────────────────────
-- Entra o par vivo cujo campo existe no schema atual e cujas duas respostas
-- foram dadas a versao atual da pergunta (a regra de leitura do par antigo).
-- O valor julgado e o snapshot gravado no par. Ficam de fora o par de outra
-- versao da pergunta e o de valores identicos. Pares que viram o mesmo par de
-- valor ficam com o dono e a data do mais antigo. A migration que remove
-- `response_equivalences` a chama de novo para os pares gravados pelo codigo
-- antigo entre esta migration e o deploy. Interna: fechada para os clientes.
-- Devolve quantas equivalencias entraram.
CREATE FUNCTION public.backfill_value_equivalences_from_response_pairs()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_inserted INTEGER;
BEGIN
  INSERT INTO public.value_equivalences (
    project_id, field_name, field_hash, value_a, value_b,
    reviewer_id, source, origin_document_id, created_at
  )
  SELECT DISTINCT ON (
    pairs.project_id, pairs.field_name, pairs.value_a, pairs.value_b
  )
    pairs.project_id, pairs.field_name, pairs.field_hash, pairs.value_a,
    pairs.value_b, pairs.reviewer_id, 'migracao', pairs.document_id,
    pairs.created_at
  FROM (
    SELECT
      equivalence.project_id,
      equivalence.field_name,
      field.value ->> 'hash' AS field_hash,
      LEAST(equivalence.response_a_answer_snapshot, equivalence.response_b_answer_snapshot) AS value_a,
      GREATEST(equivalence.response_a_answer_snapshot, equivalence.response_b_answer_snapshot) AS value_b,
      equivalence.reviewer_id,
      equivalence.document_id,
      equivalence.created_at,
      equivalence.id
    FROM public.response_equivalences AS equivalence
    JOIN public.projects AS project ON project.id = equivalence.project_id
    JOIN public.responses AS response_a ON response_a.id = equivalence.response_a_id
    JOIN public.responses AS response_b ON response_b.id = equivalence.response_b_id
    CROSS JOIN LATERAL (
      SELECT public.pydantic_field_by_name(project.pydantic_fields, equivalence.field_name) AS value
    ) AS field
    WHERE equivalence.superseded_at IS NULL
      AND field.value ->> 'hash' IS NOT NULL
      AND equivalence.response_a_answer_snapshot IS NOT NULL
      AND equivalence.response_b_answer_snapshot IS NOT NULL
      AND equivalence.response_a_answer_snapshot IS DISTINCT FROM equivalence.response_b_answer_snapshot
      AND public.response_answers_current_question(response_a.answer_field_hashes, field.value)
      AND public.response_answers_current_question(response_b.answer_field_hashes, field.value)
  ) AS pairs
  ORDER BY pairs.project_id, pairs.field_name, pairs.value_a, pairs.value_b,
           pairs.created_at, pairs.id
  ON CONFLICT (
    project_id, field_name, field_hash,
    (pg_catalog.md5(value_a::TEXT)), (pg_catalog.md5(value_b::TEXT))
  ) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  -- Todo par vivo avaliado sai de cena: o copiado e o que ficou de fora
  -- (outra versao da pergunta, valores iguais). Sem isto, a nova chamada na
  -- migration que remove a tabela recriaria a equivalencia que alguem desfez
  -- depois do deploy (o par antigo seguiria vivo, e o ON CONFLICT nao acharia
  -- mais a linha desfeita), ou carimbaria com o hash novo o par que a mudanca
  -- da pergunta derrubou. Assim cada chamada so ve os pares gravados depois da
  -- anterior. UPDATE, e nao DELETE, para nao arquivar como decisao desfeita.
  UPDATE public.response_equivalences
  SET superseded_at = pg_catalog.now(),
      superseded_reason = 'migrated_to_value'
  WHERE superseded_at IS NULL;

  RETURN v_inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.backfill_value_equivalences_from_response_pairs()
  FROM PUBLIC, anon, authenticated, service_role;

SELECT public.backfill_value_equivalences_from_response_pairs();

-- ── Auto-revisao: veredito 'equivalente' grava equivalencia de valor ──────────
CREATE OR REPLACE FUNCTION public.submit_auto_review_verdicts(p_project_id uuid, p_document_id uuid, p_reviewer_id uuid, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_row JSONB;
  v_review public.field_reviews%ROWTYPE;
  v_verdict TEXT;
  v_justification TEXT;
  v_contested_ids UUID[] := ARRAY[]::UUID[];
  v_arbitrator_id UUID;
  v_arbitrated INTEGER := 0;
  v_field_hash TEXT;
BEGIN
  IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array'
     OR pg_catalog.jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'p_rows must be a non-empty JSON array';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_project_id::TEXT || ':' || p_document_id::TEXT,
      0
    )
  );

  IF (SELECT count(*) FROM pg_catalog.jsonb_array_elements(p_rows)) <>
     (SELECT count(DISTINCT row->>'field_review_id')
      FROM pg_catalog.jsonb_array_elements(p_rows) AS rows(row)) THEN
    RAISE EXCEPTION 'field_review_id must be unique within p_rows';
  END IF;

  FOR v_row IN SELECT row FROM pg_catalog.jsonb_array_elements(p_rows) AS rows(row)
  LOOP
    SELECT * INTO v_review
    FROM public.field_reviews AS review
    WHERE review.id = (v_row->>'field_review_id')::UUID
      AND review.project_id = p_project_id
      AND review.document_id = p_document_id
      AND review.field_name = v_row->>'field_name'
      AND review.self_reviewer_id = p_reviewer_id
      AND review.superseded_at IS NULL
    FOR UPDATE;

    IF v_review.id IS NULL THEN
      RAISE EXCEPTION 'review cycle is missing, superseded, or incompatible';
    END IF;

    v_verdict := v_row->>'verdict';
    v_justification := NULLIF(pg_catalog.btrim(v_row->>'justification'), '');
    IF v_verdict NOT IN ('admite_erro', 'contesta_llm', 'equivalente', 'ambiguo')
       OR (v_verdict IN ('contesta_llm', 'ambiguo') AND v_justification IS NULL)
       OR (v_review.self_verdict IS NOT NULL AND v_review.self_verdict <> v_verdict) THEN
      RAISE EXCEPTION 'invalid or conflicting self-review verdict';
    END IF;

    IF v_review.self_verdict IS NULL THEN
      UPDATE public.field_reviews
      SET self_verdict = v_verdict,
          self_reviewed_at = pg_catalog.now(),
          self_justification = CASE
            WHEN v_verdict IN ('contesta_llm', 'ambiguo') THEN v_justification
            ELSE NULL
          END
      WHERE id = v_review.id;
    END IF;

    IF v_verdict = 'equivalente' THEN
      -- O veredito vira equivalencia de VALOR (valor humano = valor do LLM)
      -- na versao ATUAL da pergunta. Ciclo carimbado com outra versao (que
      -- escapou do save do schema) nao grava: nasceria ja morta. Valor
      -- ausente (SQL NULL) nao e valor julgado, e valores identicos nao tem o
      -- que fundir.
      v_field_hash := public.pydantic_field_by_name(
        (SELECT project.pydantic_fields FROM public.projects AS project
         WHERE project.id = p_project_id),
        v_review.field_name
      ) ->> 'hash';
      IF v_field_hash IS NOT NULL
         AND (v_review.field_hash IS NULL OR v_review.field_hash = v_field_hash)
         AND v_review.human_answer_snapshot IS NOT NULL
         AND v_review.llm_answer_snapshot IS NOT NULL
         AND v_review.human_answer_snapshot IS DISTINCT FROM v_review.llm_answer_snapshot THEN
        INSERT INTO public.value_equivalences (
          project_id, field_name, field_hash, value_a, value_b,
          reviewer_id, source, origin_document_id
        ) VALUES (
          p_project_id, v_review.field_name, v_field_hash,
          LEAST(v_review.human_answer_snapshot, v_review.llm_answer_snapshot),
          GREATEST(v_review.human_answer_snapshot, v_review.llm_answer_snapshot),
          p_reviewer_id, 'auto_revisao', p_document_id
        ) ON CONFLICT (
          project_id, field_name, field_hash,
          (pg_catalog.md5(value_a::TEXT)), (pg_catalog.md5(value_b::TEXT))
        ) DO NOTHING;
      END IF;
    ELSIF v_verdict = 'ambiguo' THEN
      IF NULLIF(v_row->>'comment_body', '') IS NULL THEN
        RAISE EXCEPTION 'ambiguity comment body is required';
      END IF;
      INSERT INTO public.project_comments (
        project_id, document_id, field_name, field_review_id, author_id, body
      ) VALUES (
        p_project_id, p_document_id, v_review.field_name, v_review.id,
        p_reviewer_id, v_row->>'comment_body'
      ) ON CONFLICT DO NOTHING;
    ELSIF v_verdict = 'contesta_llm' AND v_review.arbitrator_id IS NULL THEN
      v_contested_ids := pg_catalog.array_append(v_contested_ids, v_review.id);
    END IF;
  END LOOP;

  IF pg_catalog.cardinality(v_contested_ids) > 0 THEN
    SELECT member.user_id INTO v_arbitrator_id
    FROM public.project_members AS member
    WHERE member.project_id = p_project_id
      AND member.can_arbitrate = true
      AND member.user_id <> p_reviewer_id
    ORDER BY
      EXISTS (
        SELECT 1 FROM public.responses AS coder
        WHERE coder.project_id = p_project_id
          AND coder.document_id = p_document_id
          AND coder.respondent_type = 'humano'
          AND coder.respondent_id = member.user_id
      ),
      (SELECT count(*) FROM public.assignments AS open_assignment
       WHERE open_assignment.project_id = p_project_id
         AND open_assignment.user_id = member.user_id
         AND open_assignment.type = 'arbitragem'
         AND open_assignment.status <> 'concluido'),
      CASE WHEN member.role = 'pesquisador' THEN 0 ELSE 1 END,
      pg_catalog.random()
    LIMIT 1
    FOR UPDATE OF member;

    IF v_arbitrator_id IS NOT NULL THEN
      UPDATE public.field_reviews
      SET arbitrator_id = v_arbitrator_id
      WHERE id = ANY(v_contested_ids) AND arbitrator_id IS NULL;
      GET DIAGNOSTICS v_arbitrated = ROW_COUNT;

      IF v_arbitrated > 0 THEN
        INSERT INTO public.assignments (
          project_id, document_id, user_id, type, status
        ) VALUES (
          p_project_id, p_document_id, v_arbitrator_id, 'arbitragem', 'pendente'
        ) ON CONFLICT (document_id, user_id, type, round_id) DO UPDATE
          SET status = 'pendente',
              completed_at = NULL
          WHERE assignments.status = 'concluido';
      END IF;
    END IF;
  END IF;

  UPDATE public.assignments AS assignment
  SET status = 'concluido', completed_at = pg_catalog.now()
  WHERE assignment.project_id = p_project_id
    AND assignment.document_id = p_document_id
    AND assignment.user_id = p_reviewer_id
    AND assignment.type = 'auto_revisao'
    AND NOT EXISTS (
      SELECT 1 FROM public.field_reviews AS review
      WHERE review.project_id = p_project_id
        AND review.document_id = p_document_id
        AND review.self_reviewer_id = p_reviewer_id
        AND review.self_verdict IS NULL
    );

  RETURN pg_catalog.jsonb_build_object(
    'arbitrated', v_arbitrated,
    'no_pool', pg_catalog.cardinality(v_contested_ids) > 0
      AND v_arbitrator_id IS NULL
  );
END;
$function$;


-- ── Reconciliador: versao das equivalencias por campo do projeto ──────────────
CREATE OR REPLACE FUNCTION public.reconcile_auto_review_cycles(p_groups jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

    -- As equivalencias de valor que o worker usou para este documento (as das
    -- classes dos valores do humano e do LLM, calculadas no TS, onde a chave
    -- normalizada vive) ainda existem. Desfazer uma delas recusa a
    -- reconciliacao; criar uma nova nao precisa recusar, porque a propagacao
    -- da criacao reenfileira o documento com outro `requested_at`, e o ACK
    -- desta leitura nao apaga o pedido novo. Conferir so as do documento, e
    -- nao todas as do projeto, evita que um "=" em outro documento derrube
    -- toda reconciliacao em curso.
    SELECT COALESCE(
      pg_catalog.jsonb_agg(locked.id::TEXT ORDER BY locked.id),
      '[]'::JSONB
    )
    INTO v_current_equivalence_ids
    FROM (
      SELECT equivalence.id
      FROM public.value_equivalences AS equivalence
      WHERE equivalence.project_id = v_human.project_id
        AND equivalence.id::TEXT IN (
          SELECT expected.id
          FROM pg_catalog.jsonb_array_elements_text(
            COALESCE(v_group->'expected_equivalence_ids', '[]'::JSONB)
          ) AS expected(id)
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
$function$;


-- ── Save do schema: equivalencia de outra versao da pergunta vai ao historico ───
CREATE OR REPLACE FUNCTION public.archive_question_changed_field_reviews(p_project_id uuid, p_previous_fields jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_project public.projects%ROWTYPE;
  v_archived INTEGER;
  v_documents UUID[];
  v_requeue UUID[];
  v_stale_pairs UUID[];
  v_returning UUID[];
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

  IF v_archived > 0 THEN
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
  END IF;

  -- Equivalencia de valor que deixou de valer: o campo saiu do schema
  -- ('field_removed') ou a pergunta mudou e o hash atual nao e o dela
  -- ('question_changed'). Ela vai para o historico (pelo gatilho de DELETE),
  -- e o documento com resposta no campo que continua existindo volta ao
  -- reconciliador: a equivalencia pode ser a unica razao de o campo nao
  -- divergir. A conta e por campo, nao por documento, porque a chave do valor
  -- (normalizada) so existe no TS; enfileirar a mais custa so uma
  -- reconciliacao idempotente, e acontece so no save que derruba alguma
  -- equivalencia. Campo removido nao enfileira, como os ciclos acima; quando
  -- o nome volta ao schema (removido e readicionado, renomeacao desfeita),
  -- entram os documentos com resposta vigente igual a um dos valores de uma
  -- equivalencia do historico daquele nome: a que fundia os valores ja nao
  -- vale sob a definicao nova. A igualdade e de JSON bruto, nao normalizada:
  -- delimita o conjunto aos documentos que de fato usavam aqueles valores, em
  -- vez do projeto inteiro, e um documento com variante so de caixa ou espaco
  -- fica para o proximo save ou para o reparo do coordenador.
  UPDATE public.value_equivalences AS equivalence
  SET superseded_at = pg_catalog.now(),
      superseded_reason = CASE
        WHEN public.pydantic_field_by_name(v_project.pydantic_fields, equivalence.field_name) IS NULL
        THEN 'field_removed'
        ELSE 'question_changed'
      END
  WHERE equivalence.project_id = v_project.id
    AND (public.pydantic_field_by_name(v_project.pydantic_fields, equivalence.field_name) ->> 'hash')
        IS DISTINCT FROM equivalence.field_hash;

  SELECT pg_catalog.array_agg(DISTINCT stale.document_id)
  INTO v_stale_pairs
  FROM (
    SELECT response.document_id
    FROM public.responses AS response
    WHERE response.project_id = v_project.id
      AND response.is_latest = true
      AND response.answers ?| ARRAY(
        SELECT DISTINCT equivalence.field_name
        FROM public.value_equivalences AS equivalence
        WHERE equivalence.project_id = v_project.id
          AND equivalence.superseded_at IS NOT NULL
          AND public.pydantic_field_by_name(v_project.pydantic_fields, equivalence.field_name) IS NOT NULL
      )
    UNION
    SELECT response.document_id
    FROM public.value_equivalence_history_entries AS history
    JOIN public.responses AS response
      ON response.project_id = history.project_id
      AND response.is_latest = true
      AND (response.answers -> history.field_name) IN (history.value_a, history.value_b)
    WHERE p_previous_fields IS NOT NULL
      AND history.project_id = v_project.id
      AND public.pydantic_field_by_name(p_previous_fields, history.field_name) IS NULL
      AND public.pydantic_field_by_name(v_project.pydantic_fields, history.field_name) IS NOT NULL
  ) AS stale;

  DELETE FROM public.value_equivalences AS equivalence
  WHERE equivalence.project_id = v_project.id
    AND equivalence.superseded_at IS NOT NULL;

  -- Campo que volta ao schema (renomeacao desfeita, campo removido e
  -- readicionado): o save que o tirou arquivou os ciclos como 'field_removed'
  -- sem enfileirar, e na volta nao ha ciclo a arquivar. Entram so os
  -- documentos com ciclo arquivado por remocao daquele nome, e nao os que tem
  -- resposta no campo, que na renomeacao desfeita seriam o projeto inteiro.
  -- Campo novo sem esse historico nao enfileira nada.
  IF p_previous_fields IS NOT NULL THEN
    SELECT pg_catalog.array_agg(DISTINCT history.document_id)
    INTO v_returning
    FROM pg_catalog.jsonb_array_elements(v_project.pydantic_fields) AS field(value)
    JOIN public.field_review_cycle_history_entries AS history
      ON history.project_id = v_project.id
      AND history.field_name = field.value->>'name'
      AND history.superseded_reason = 'field_removed'
    WHERE public.pydantic_field_by_name(p_previous_fields, field.value->>'name') IS NULL;
  END IF;

  v_requeue := ARRAY(
    SELECT DISTINCT document_id
    FROM pg_catalog.unnest(COALESCE(v_requeue, '{}'::UUID[]) || COALESCE(v_stale_pairs, '{}'::UUID[])
                           || COALESCE(v_returning, '{}'::UUID[]))
      AS documents(document_id)
  );

  IF pg_catalog.cardinality(v_requeue) = 0 THEN
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
$function$;


REVOKE ALL ON FUNCTION public.archive_question_changed_field_reviews(UUID, JSONB)
  FROM PUBLIC, anon, authenticated, service_role;

-- ── Unificacao de membros leva a equivalencia de valor junto ──────────────────
CREATE OR REPLACE FUNCTION public.unify_project_members(p_project_id uuid, p_source_user_id uuid, p_target_user_id uuid, p_linked_user_id uuid, p_link_email text, p_acting_user_id uuid, p_expected_snapshot_version bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    public.value_equivalences,
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
  -- Demover ANTES de repontar (#609). O repoint sozinho produz duas linhas
  -- correntes do target no mesmo documento sempre que source e target
  -- codificaram o mesmo doc, e responses_one_latest_human_per_document é
  -- imediato — índice parcial não pode ser DEFERRABLE. Rankear sobre a UNIÃO
  -- source ∪ target dá o mesmo vencedor que o rank pós-repoint dava sobre o
  -- conjunto fundido, com o mesmo desempate; só a ordem das duas mutações
  -- mudou. Manter nesta ordem.
  WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY document_id
             ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
           ) AS rn
    FROM public.responses
    WHERE project_id = p_project_id
      AND respondent_id IN (p_source_user_id, p_target_user_id)
      AND respondent_type = 'humano'
      AND is_latest
  )
  UPDATE public.responses r
  SET is_latest = false
  FROM ranked
  WHERE r.id = ranked.id AND ranked.rn > 1;

  UPDATE public.responses
  SET respondent_id = p_target_user_id
  WHERE project_id = p_project_id AND respondent_id = p_source_user_id;

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

  -- ===== value_equivalences =====
  -- A unicidade nao envolve reviewer_id: a reescrita nao colide.
  UPDATE public.value_equivalences
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
$function$;


COMMIT;
