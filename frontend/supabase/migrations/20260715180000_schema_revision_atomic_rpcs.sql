-- Uma revisão monotônica é a identidade concorrente canônica do schema. O
-- trigger torna impossível alterar a representação ou a versão do schema sem
-- avançar exatamente uma revisão, e também impede avançar a revisão sem uma
-- mudança correspondente. pydantic_hash fica fora da identidade: o runner
-- pode atualizá-lo isoladamente sem criar uma revisão fictícia.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

UPDATE public.projects
SET pydantic_fields = '[]'::jsonb
WHERE pydantic_fields IS NULL;

ALTER TABLE public.projects
  ALTER COLUMN pydantic_fields SET DEFAULT '[]'::jsonb,
  ALTER COLUMN pydantic_fields SET NOT NULL;

ALTER TABLE public.projects
  ADD COLUMN schema_revision bigint NOT NULL DEFAULT 0
  CONSTRAINT projects_schema_revision_nonnegative CHECK (schema_revision >= 0);

CREATE OR REPLACE FUNCTION public.enforce_project_schema_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_schema_changed boolean;
BEGIN
  v_schema_changed :=
    NEW.pydantic_fields IS DISTINCT FROM OLD.pydantic_fields
    OR NEW.pydantic_code IS DISTINCT FROM OLD.pydantic_code
    OR NEW.schema_version_major IS DISTINCT FROM OLD.schema_version_major
    OR NEW.schema_version_minor IS DISTINCT FROM OLD.schema_version_minor
    OR NEW.schema_version_patch IS DISTINCT FROM OLD.schema_version_patch;

  IF v_schema_changed
     AND NEW.schema_revision IS DISTINCT FROM OLD.schema_revision + 1 THEN
    RAISE EXCEPTION
      'Schema changes must increment schema_revision exactly once'
      USING ERRCODE = '23514';
  END IF;

  IF NOT v_schema_changed
     AND NEW.schema_revision IS DISTINCT FROM OLD.schema_revision THEN
    RAISE EXCEPTION
      'schema_revision cannot change without a schema change'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_project_schema_revision_trigger
  ON public.projects;
CREATE TRIGGER enforce_project_schema_revision_trigger
  BEFORE UPDATE ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_project_schema_revision();

-- Porta de entrada comum de toda escrita guardada pela revisão do schema:
-- resolve visibilidade e autorização, trava a linha e confere o compare-and-swap
-- da revisão. `schema_write_gate` (e, por ele, `commit_project_schema` e
-- `apply_schema_backfill`) e `resolve_schema_suggestion` exigem exatamente esta
-- sequência, e mantê-la em duplicata deixava-as livres para divergirem numa
-- correção futura.
--
-- A validação da versão-alvo NÃO mora aqui: quem resolve uma sugestão sem
-- mudança de schema não escreve versão nenhuma, e só teria um trio de argumentos
-- a inventar. Ela é a única parte que distingue os dois usos, então é ela que
-- fica no `schema_write_gate` — a alternativa era um parâmetro opcional que
-- significasse "ignore este trio", ou seja, um modo a mais para manter de acordo.
--
-- Devolve 'ok' com o estado travado, ou o estado terminal ('not_found',
-- 'forbidden', 'conflict') que o chamador repassa. O `FOR UPDATE` vale para a
-- transação inteira, não só para esta função — é o mesmo lock que serializa o
-- chamador contra outra escrita concorrente.
--
-- SECURITY INVOKER: as policies seguem sendo a fonte de autorização, e a checagem
-- explícita só converte os resultados filtrados pela RLS em estados estáveis.
CREATE OR REPLACE FUNCTION public.schema_revision_gate(
  p_project_id uuid,
  p_expected_revision bigint
) RETURNS TABLE(
  status text,
  schema_revision bigint,
  pydantic_fields jsonb,
  schema_version_major int,
  schema_version_minor int,
  schema_version_patch int
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_revision bigint;
  v_fields jsonb;
  v_major int;
  v_minor int;
  v_patch int;
BEGIN
  IF p_expected_revision IS NULL
     OR p_expected_revision < 0 THEN
    RAISE EXCEPTION 'Schema revisions must be non-negative'
      USING ERRCODE = '22023';
  END IF;

  -- Uma linha invisível pela policy SELECT é indistinguível de uma linha
  -- inexistente. Um membro pesquisador enxerga o projeto, mas não pertence ao
  -- conjunto de escritores, e por isso recebe forbidden.
  PERFORM 1
  FROM public.projects AS p
  WHERE p.id = p_project_id;
  IF NOT FOUND THEN
    RETURN QUERY
      SELECT 'not_found', NULL::bigint, NULL::jsonb,
             NULL::int, NULL::int, NULL::int;
    RETURN;
  END IF;

  v_uid := public.clerk_uid();
  IF v_uid IS NOT NULL
     AND NOT public.is_master()
     AND NOT EXISTS (
       SELECT 1
       FROM public.auth_user_coordinator_or_creator_project_ids() AS allowed(id)
       WHERE allowed.id = p_project_id
     ) THEN
    RETURN QUERY
      SELECT 'forbidden', NULL::bigint, NULL::jsonb,
             NULL::int, NULL::int, NULL::int;
    RETURN;
  END IF;

  SELECT p.schema_revision,
         p.pydantic_fields,
         p.schema_version_major,
         p.schema_version_minor,
         p.schema_version_patch
  INTO v_revision, v_fields, v_major, v_minor, v_patch
  FROM public.projects AS p
  WHERE p.id = p_project_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY
      SELECT 'forbidden', NULL::bigint, NULL::jsonb,
             NULL::int, NULL::int, NULL::int;
    RETURN;
  END IF;

  IF v_revision <> p_expected_revision THEN
    RETURN QUERY
      SELECT 'conflict', v_revision, v_fields, v_major, v_minor, v_patch;
    RETURN;
  END IF;

  RETURN QUERY
    SELECT 'ok', v_revision, v_fields, v_major, v_minor, v_patch;
END;
$$;

-- `service_role` precisa do EXECUTE porque as RPCs que chamam este gate são
-- SECURITY INVOKER: o privilégio da chamada interna é conferido contra o papel
-- efetivo, e `service_role` não herda de `authenticated`. Sem isto, toda RPC de
-- schema chamada com a service key morre em `permission denied` aqui dentro —
-- e o caminho é projetado, não acidental: a guarda de autorização acima é
-- pulada justamente quando `clerk_uid()` é nulo, que é o caso da service key.
REVOKE ALL ON FUNCTION public.schema_revision_gate(
  uuid, bigint
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.schema_revision_gate(
  uuid, bigint
) TO authenticated, service_role;

-- Acrescenta ao gate a validação do trio de versão que o chamador vai gravar.
-- Aceitar nulo aqui gravaria versão nula em `projects`, que `compare-version.ts`
-- lê como "projeto anterior ao versionamento" — o mesmo rebaixamento silencioso
-- que `p_pydantic_code` nulo causaria via `pydantic_hash`.
CREATE OR REPLACE FUNCTION public.schema_write_gate(
  p_project_id uuid,
  p_expected_revision bigint,
  p_version_major int,
  p_version_minor int,
  p_version_patch int
) RETURNS TABLE(
  status text,
  schema_revision bigint,
  pydantic_fields jsonb,
  schema_version_major int,
  schema_version_minor int,
  schema_version_patch int
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF p_version_major IS NULL
     OR p_version_minor IS NULL
     OR p_version_patch IS NULL
     OR p_version_major < 0
     OR p_version_minor < 0
     OR p_version_patch < 0 THEN
    RAISE EXCEPTION 'Schema versions must be non-negative'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
    SELECT g.status,
           g.schema_revision,
           g.pydantic_fields,
           g.schema_version_major,
           g.schema_version_minor,
           g.schema_version_patch
    FROM public.schema_revision_gate(p_project_id, p_expected_revision) AS g;
END;
$$;

REVOKE ALL ON FUNCTION public.schema_write_gate(
  uuid, bigint, int, int, int
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.schema_write_gate(
  uuid, bigint, int, int, int
) TO authenticated, service_role;

-- Commit único de projects + schema_change_log.
CREATE OR REPLACE FUNCTION public.commit_project_schema(
  p_project_id uuid,
  p_expected_revision bigint,
  p_pydantic_fields jsonb,
  p_pydantic_code text,
  p_version_major int,
  p_version_minor int,
  p_version_patch int,
  p_change_type text,
  p_log_entries jsonb,
  p_changed_by uuid
) RETURNS TABLE(
  status text,
  schema_revision bigint,
  pydantic_fields jsonb,
  schema_version_major int,
  schema_version_minor int,
  schema_version_patch int
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_status text;
  v_revision bigint;
  v_fields jsonb;
  v_major int;
  v_minor int;
  v_patch int;
BEGIN
  IF p_change_type IS NULL
     OR p_change_type NOT IN ('major', 'minor', 'patch') THEN
    RAISE EXCEPTION 'Invalid schema change_type: %', p_change_type
      USING ERRCODE = '22023';
  END IF;

  IF p_pydantic_fields IS NULL
     OR jsonb_typeof(p_pydantic_fields) <> 'array' THEN
    RAISE EXCEPTION 'p_pydantic_fields must be a JSON array'
      USING ERRCODE = '22023';
  END IF;

  -- `pydantic_hash` é derivado do código e de nada mais, então aceitar código
  -- nulo gravaria hash nulo — que `compare-version.ts` lê como "projeto anterior
  -- ao versionamento". Todo caller gera o código a partir dos campos; só
  -- `publishMajorVersion` reapresenta o código armazenado, e ele recusa antes de
  -- chegar aqui quando o projeto não tem schema. O nulo não descreve estado
  -- legítimo nenhum.
  IF p_pydantic_code IS NULL THEN
    RAISE EXCEPTION 'p_pydantic_code must not be null'
      USING ERRCODE = '22023';
  END IF;

  IF p_log_entries IS NULL
     OR jsonb_typeof(p_log_entries) <> 'array'
     OR jsonb_array_length(p_log_entries) = 0 THEN
    RAISE EXCEPTION 'p_log_entries must be a non-empty JSON array'
      USING ERRCODE = '22023';
  END IF;

  -- Antes do gate: a autoria é do payload, não do projeto, e recusá-la aqui
  -- evita travar a linha por uma chamada que nunca poderia escrever. A RPC tem
  -- GRANT para `authenticated`, ou seja, é chamável direto via PostgREST — sem
  -- isto, quem tem JWT poderia assinar no schema_change_log uma mudança em nome
  -- de outra pessoa.
  v_uid := public.clerk_uid();
  IF v_uid IS NOT NULL AND p_changed_by IS DISTINCT FROM v_uid THEN
    RETURN QUERY
      SELECT 'forbidden', NULL::bigint, NULL::jsonb,
             NULL::int, NULL::int, NULL::int;
    RETURN;
  END IF;

  SELECT g.status,
         g.schema_revision,
         g.pydantic_fields,
         g.schema_version_major,
         g.schema_version_minor,
         g.schema_version_patch
  INTO v_status, v_revision, v_fields, v_major, v_minor, v_patch
  FROM public.schema_write_gate(
    p_project_id,
    p_expected_revision,
    p_version_major,
    p_version_minor,
    p_version_patch
  ) AS g;

  IF v_status <> 'ok' THEN
    RETURN QUERY
      SELECT v_status, v_revision, v_fields, v_major, v_minor, v_patch;
    RETURN;
  END IF;

  IF (p_change_type = 'major' AND
      (p_version_major, p_version_minor, p_version_patch)
        IS DISTINCT FROM (v_major + 1, 0, 0))
     OR (p_change_type = 'minor' AND
         (p_version_major, p_version_minor, p_version_patch)
           IS DISTINCT FROM (v_major, v_minor + 1, 0))
     OR (p_change_type = 'patch' AND
         (p_version_major, p_version_minor, p_version_patch)
           IS DISTINCT FROM (v_major, v_minor, v_patch + 1)) THEN
    RAISE EXCEPTION
      'Schema change_type % does not match version transition %.%.% -> %.%.%',
      p_change_type, v_major, v_minor, v_patch,
      p_version_major, p_version_minor, p_version_patch
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.projects AS p
  SET pydantic_fields = p_pydantic_fields,
      pydantic_code = p_pydantic_code,
      pydantic_hash = substring(
        encode(extensions.digest(p_pydantic_code, 'sha256'), 'hex')
        FROM 1 FOR 16
      ),
      schema_version_major = p_version_major,
      schema_version_minor = p_version_minor,
      schema_version_patch = p_version_patch,
      schema_revision = v_revision + 1
  WHERE p.id = p_project_id
  RETURNING p.schema_revision,
            p.pydantic_fields,
            p.schema_version_major,
            p.schema_version_minor,
            p.schema_version_patch
  INTO v_revision, v_fields, v_major, v_minor, v_patch;

  IF NOT FOUND THEN
    RETURN QUERY
      SELECT 'forbidden', NULL::bigint, NULL::jsonb,
             NULL::int, NULL::int, NULL::int;
    RETURN;
  END IF;

  INSERT INTO public.schema_change_log (
    project_id,
    changed_by,
    field_name,
    change_summary,
    before_value,
    after_value,
    change_type,
    version_major,
    version_minor,
    version_patch
  )
  SELECT p_project_id,
         p_changed_by,
         entry.field_name,
         entry.change_summary,
         entry.before_value,
         entry.after_value,
         p_change_type,
         p_version_major,
         p_version_minor,
         p_version_patch
  FROM jsonb_to_recordset(COALESCE(p_log_entries, '[]'::jsonb)) AS entry(
    field_name text,
    change_summary text,
    before_value jsonb,
    after_value jsonb
  );

  RETURN QUERY
    SELECT 'saved', v_revision, v_fields, v_major, v_minor, v_patch;
END;
$$;

REVOKE ALL ON FUNCTION public.commit_project_schema(
  uuid, bigint, jsonb, text, int, int, int, text, jsonb, uuid
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.commit_project_schema(
  uuid, bigint, jsonb, text, int, int, int, text, jsonb, uuid
) TO authenticated, service_role;

-- Aprovar uma sugestão e aplicar seu schema é uma única transação. A função
-- reutiliza o commit canônico; se a sugestão não puder ser resolvida, a exceção
-- reverte também projeto e histórico.
CREATE OR REPLACE FUNCTION public.approve_schema_suggestion(
  p_suggestion_id uuid,
  p_project_id uuid,
  p_expected_revision bigint,
  p_pydantic_fields jsonb,
  p_pydantic_code text,
  p_version_major int,
  p_version_minor int,
  p_version_patch int,
  p_change_type text,
  p_log_entries jsonb,
  p_changed_by uuid
) RETURNS TABLE(
  status text,
  schema_revision bigint,
  pydantic_fields jsonb,
  schema_version_major int,
  schema_version_minor int,
  schema_version_patch int
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_commit record;
  v_suggestion_id uuid;
BEGIN
  SELECT * INTO v_commit
  FROM public.commit_project_schema(
    p_project_id,
    p_expected_revision,
    p_pydantic_fields,
    p_pydantic_code,
    p_version_major,
    p_version_minor,
    p_version_patch,
    p_change_type,
    p_log_entries,
    p_changed_by
  );

  IF v_commit.status <> 'saved' THEN
    RETURN QUERY
      SELECT v_commit.status,
             v_commit.schema_revision,
             v_commit.pydantic_fields,
             v_commit.schema_version_major,
             v_commit.schema_version_minor,
             v_commit.schema_version_patch;
    RETURN;
  END IF;

  UPDATE public.schema_suggestions AS suggestion
  SET status = 'approved',
      resolved_by = p_changed_by,
      resolved_at = now()
  WHERE suggestion.id = p_suggestion_id
    AND suggestion.project_id = p_project_id
    AND suggestion.status = 'pending'
  RETURNING suggestion.id INTO v_suggestion_id;

  IF v_suggestion_id IS NULL THEN
    RAISE EXCEPTION 'Suggestion is missing, belongs to another project, or is not pending'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
    SELECT v_commit.status,
           v_commit.schema_revision,
           v_commit.pydantic_fields,
           v_commit.schema_version_major,
           v_commit.schema_version_minor,
           v_commit.schema_version_patch;
END;
$$;

REVOKE ALL ON FUNCTION public.approve_schema_suggestion(
  uuid, uuid, bigint, jsonb, text, int, int, int, text, jsonb, uuid
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_schema_suggestion(
  uuid, uuid, bigint, jsonb, text, int, int, int, text, jsonb, uuid
) TO authenticated, service_role;

-- Aprovar uma sugestão cujo conteúdo o schema JÁ tem — porque o coordenador
-- aplicou a mudança à mão antes de aprovar — não commita coisa alguma: não há
-- diff, e `commit_project_schema` recusa log vazio por contrato. Sem esta porta,
-- `approve_schema_suggestion` era a única forma de aprovar, o commit interno
-- falhava, e o único desfecho possível para uma sugestão atendida era REJEITÁ-LA.
--
-- O gate — e não um `EXISTS` sobre `projects` dentro do WHERE — é o que confere
-- autorização e o compare-and-swap: o `FOR UPDATE` dele segura a linha do projeto
-- até o fim da transação, então o "o schema não mudou" que autoriza a aprovação
-- ainda é verdade quando o UPDATE grava. Um CAS sem o lock valeria só no instante
-- da leitura, e um commit concorrente poderia deixar a sugestão aprovada logo
-- depois de o schema deixar de contê-la.
CREATE OR REPLACE FUNCTION public.resolve_schema_suggestion(
  p_suggestion_id uuid,
  p_project_id uuid,
  p_expected_revision bigint,
  p_resolved_by uuid
) RETURNS TABLE(
  status text,
  schema_revision bigint,
  pydantic_fields jsonb,
  schema_version_major int,
  schema_version_minor int,
  schema_version_patch int
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_status text;
  v_revision bigint;
  v_fields jsonb;
  v_major int;
  v_minor int;
  v_patch int;
  v_suggestion_id uuid;
BEGIN
  SELECT g.status,
         g.schema_revision,
         g.pydantic_fields,
         g.schema_version_major,
         g.schema_version_minor,
         g.schema_version_patch
  INTO v_status, v_revision, v_fields, v_major, v_minor, v_patch
  FROM public.schema_revision_gate(p_project_id, p_expected_revision) AS g;

  IF v_status <> 'ok' THEN
    RETURN QUERY
      SELECT v_status, v_revision, v_fields, v_major, v_minor, v_patch;
    RETURN;
  END IF;

  UPDATE public.schema_suggestions AS suggestion
  SET status = 'approved',
      resolved_by = p_resolved_by,
      resolved_at = now()
  WHERE suggestion.id = p_suggestion_id
    AND suggestion.project_id = p_project_id
    AND suggestion.status = 'pending'
  RETURNING suggestion.id INTO v_suggestion_id;

  IF v_suggestion_id IS NULL THEN
    RAISE EXCEPTION 'Suggestion is missing, belongs to another project, or is not pending'
      USING ERRCODE = 'P0001';
  END IF;

  -- 'saved' e não 'ok': o chamador é o mesmo `mapCommitResult` das demais, e o
  -- schema resultante é exatamente o que o gate travou.
  RETURN QUERY
    SELECT 'saved', v_revision, v_fields, v_major, v_minor, v_patch;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_schema_suggestion(
  uuid, uuid, bigint, uuid
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_schema_suggestion(
  uuid, uuid, bigint, uuid
) TO authenticated, service_role;

-- Backfill transacional: o cálculo e o agrupamento permanecem puros no
-- frontend; esta fronteira aplica todas as classificações e versões ou nenhuma.
-- p_log_updates contém linhas por id. p_response_updates contém buckets com
-- ids[], versão e version_inferred_from.
CREATE OR REPLACE FUNCTION public.apply_schema_backfill(
  p_project_id uuid,
  p_expected_revision bigint,
  p_final_major int,
  p_final_minor int,
  p_final_patch int,
  p_log_updates jsonb,
  p_response_updates jsonb
) RETURNS TABLE(
  status text,
  schema_revision bigint,
  pydantic_fields jsonb,
  schema_version_major int,
  schema_version_minor int,
  schema_version_patch int
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_status text;
  v_revision bigint;
  v_fields jsonb;
  v_major int;
  v_minor int;
  v_patch int;
  v_expected int;
  v_affected int;
  v_distinct int;
  v_total int;
BEGIN
  IF (p_log_updates IS NOT NULL AND jsonb_typeof(p_log_updates) <> 'array')
     OR (p_response_updates IS NOT NULL
         AND jsonb_typeof(p_response_updates) <> 'array') THEN
    RAISE EXCEPTION 'Backfill updates must be JSON arrays'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(COALESCE(p_log_updates, '[]'::jsonb)) AS update_row(
      id uuid,
      change_type text,
      version_major int,
      version_minor int,
      version_patch int
    )
    WHERE update_row.id IS NULL
       OR update_row.change_type IS NULL
       OR update_row.change_type NOT IN ('major', 'minor', 'patch', 'initial')
       OR update_row.version_major IS NULL
       OR update_row.version_minor IS NULL
       OR update_row.version_patch IS NULL
       OR update_row.version_major < 0
       OR update_row.version_minor < 0
       OR update_row.version_patch < 0
  ) THEN
    RAISE EXCEPTION 'Invalid schema log backfill entry'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(
      COALESCE(p_response_updates, '[]'::jsonb)
    ) AS update_bucket(
      ids uuid[],
      version_major int,
      version_minor int,
      version_patch int,
      version_inferred_from text
    )
    WHERE update_bucket.ids IS NULL
       OR update_bucket.version_major IS NULL
       OR update_bucket.version_minor IS NULL
       OR update_bucket.version_patch IS NULL
       OR update_bucket.version_inferred_from IS NULL
       OR update_bucket.version_major < 0
       OR update_bucket.version_minor < 0
       OR update_bucket.version_patch < 0
       -- 'live_save' fica fora do whitelist de propósito: é a marca de versão
       -- gravada ao vivo pelo save, e tanto o filtro do UPDATE abaixo quanto a
       -- contagem de cobertura a tratam como precisa e intocável. Aceitá-la aqui
       -- deixaria um chamador carimbar de precisa uma versão que o backfill
       -- *adivinhou* — e, como o filtro pula quem já é 'live_save', a marca
       -- errada nunca mais seria revisada. Nenhum caller a produz
       -- (matchResponsesToVersions descarta essas respostas antes de formar
       -- bucket); recusar aqui é o que torna o estado irrepresentável.
       OR update_bucket.version_inferred_from NOT IN (
         'hashes', 'created_at', 'fallback_created_at'
       )
  ) THEN
    RAISE EXCEPTION 'Invalid response backfill bucket'
      USING ERRCODE = '22023';
  END IF;

  SELECT g.status,
         g.schema_revision,
         g.pydantic_fields,
         g.schema_version_major,
         g.schema_version_minor,
         g.schema_version_patch
  INTO v_status, v_revision, v_fields, v_major, v_minor, v_patch
  FROM public.schema_write_gate(
    p_project_id,
    p_expected_revision,
    p_final_major,
    p_final_minor,
    p_final_patch
  ) AS g;

  IF v_status <> 'ok' THEN
    RETURN QUERY
      SELECT v_status, v_revision, v_fields, v_major, v_minor, v_patch;
    RETURN;
  END IF;

  IF (v_major, v_minor, v_patch)
       IS DISTINCT FROM (p_final_major, p_final_minor, p_final_patch)
     AND jsonb_array_length(COALESCE(p_log_updates, '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'Backfill cannot change schema version without log updates'
      USING ERRCODE = '22023';
  END IF;

  WITH requested AS MATERIALIZED (
    SELECT update_row.id,
           update_row.change_type,
           update_row.version_major,
           update_row.version_minor,
           update_row.version_patch
    FROM jsonb_to_recordset(COALESCE(p_log_updates, '[]'::jsonb)) AS update_row(
      id uuid,
      change_type text,
      version_major int,
      version_minor int,
      version_patch int
    )
  ), updated AS (
    UPDATE public.schema_change_log AS log
    SET change_type = requested.change_type,
        version_major = requested.version_major,
        version_minor = requested.version_minor,
        version_patch = requested.version_patch
    FROM requested
    WHERE log.id = requested.id
      AND log.project_id = p_project_id
    RETURNING log.id
  )
  SELECT (SELECT count(*) FROM requested),
         (SELECT count(DISTINCT id) FROM requested),
         (SELECT count(*) FROM updated)
  INTO v_expected, v_distinct, v_affected;

  IF v_distinct <> v_expected THEN
    RAISE EXCEPTION 'Backfill log ids must be unique'
      USING ERRCODE = '22023';
  END IF;

  IF v_affected <> v_expected THEN
    RAISE EXCEPTION
      'Backfill log count mismatch: expected %, updated %',
      v_expected, v_affected
      USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_total
  FROM public.schema_change_log AS log
  WHERE log.project_id = p_project_id;

  IF v_expected <> v_total THEN
    RAISE EXCEPTION
      'Backfill log coverage mismatch: expected %, received %',
      v_total, v_expected
      USING ERRCODE = 'P0001';
  END IF;

  WITH buckets AS MATERIALIZED (
    SELECT update_bucket.ids,
           update_bucket.version_major,
           update_bucket.version_minor,
           update_bucket.version_patch,
           update_bucket.version_inferred_from
    FROM jsonb_to_recordset(
      COALESCE(p_response_updates, '[]'::jsonb)
    ) AS update_bucket(
      ids uuid[],
      version_major int,
      version_minor int,
      version_patch int,
      version_inferred_from text
    )
  ), requested AS MATERIALIZED (
    SELECT id,
           bucket.version_major,
           bucket.version_minor,
           bucket.version_patch,
           bucket.version_inferred_from
    FROM buckets AS bucket
    CROSS JOIN LATERAL unnest(COALESCE(bucket.ids, ARRAY[]::uuid[])) AS id
  ), updated AS (
    UPDATE public.responses AS response
    SET schema_version_major = requested.version_major,
        schema_version_minor = requested.version_minor,
        schema_version_patch = requested.version_patch,
        version_inferred_from = requested.version_inferred_from
    FROM requested
    WHERE response.id = requested.id
      AND response.project_id = p_project_id
      AND response.version_inferred_from IS DISTINCT FROM 'live_save'
    RETURNING response.id
  )
  SELECT (SELECT count(*) FROM requested),
         (SELECT count(DISTINCT id) FROM requested),
         (SELECT count(*) FROM updated)
  INTO v_expected, v_distinct, v_affected;

  IF v_distinct <> v_expected THEN
    RAISE EXCEPTION 'Backfill response ids must be unique'
      USING ERRCODE = '22023';
  END IF;

  IF v_affected <> v_expected THEN
    RAISE EXCEPTION
      'Backfill response count mismatch: expected %, updated %',
      v_expected, v_affected
      USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_total
  FROM public.responses AS response
  WHERE response.project_id = p_project_id
    AND response.version_inferred_from IS DISTINCT FROM 'live_save';

  IF v_expected <> v_total THEN
    RAISE EXCEPTION
      'Backfill response coverage mismatch: expected %, received %',
      v_total, v_expected
      USING ERRCODE = 'P0001';
  END IF;

  IF (v_major, v_minor, v_patch)
     IS DISTINCT FROM (p_final_major, p_final_minor, p_final_patch) THEN
    UPDATE public.projects AS p
    SET schema_version_major = p_final_major,
        schema_version_minor = p_final_minor,
        schema_version_patch = p_final_patch,
        schema_revision = v_revision + 1
    WHERE p.id = p_project_id
    RETURNING p.schema_revision,
              p.pydantic_fields,
              p.schema_version_major,
              p.schema_version_minor,
              p.schema_version_patch
    INTO v_revision, v_fields, v_major, v_minor, v_patch;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Backfill lost project update permission'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN QUERY
    SELECT 'saved', v_revision, v_fields, v_major, v_minor, v_patch;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_schema_backfill(
  uuid, bigint, int, int, int, jsonb, jsonb
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_schema_backfill(
  uuid, bigint, int, int, int, jsonb, jsonb
) TO authenticated, service_role;
