-- Regressão da revisão monotônica e das RPCs atômicas de schema.
--
-- Como rodar depois de `npx supabase start` e `npx supabase db reset`:
--   docker exec -i supabase_db_frontend psql -U postgres -d postgres \
--     -X -v ON_ERROR_STOP=1 < supabase/tests/schema_revision_rpcs.test.sql
--
-- O teste inteiro roda em BEGIN ... ROLLBACK. Os GRANTs compensam o ambiente
-- local e também são revertidos.

BEGIN;

-- ----- Fixtures -----
INSERT INTO auth.users (id, email) VALUES
  ('81000000-0000-0000-0000-000000000001', 'schema-coordinator@example.test'),
  ('81000000-0000-0000-0000-000000000002', 'schema-researcher@example.test'),
  ('81000000-0000-0000-0000-000000000003', 'schema-outsider@example.test');

INSERT INTO public.projects (
  id,
  name,
  created_by,
  pydantic_fields,
  pydantic_code,
  pydantic_hash
) VALUES
  (
    '82000000-0000-0000-0000-000000000001',
    'schema rpc test',
    '81000000-0000-0000-0000-000000000001',
    '[{"name":"old_field"}]',
    'class Analysis: old',
    'hash-old'
  ),
  (
    '82000000-0000-0000-0000-000000000002',
    'schema trigger test',
    '81000000-0000-0000-0000-000000000001',
    '[]',
    'class Analysis: pass',
    'hash-trigger'
  );

INSERT INTO public.project_members (project_id, user_id, role) VALUES
  (
    '82000000-0000-0000-0000-000000000001',
    '81000000-0000-0000-0000-000000000001',
    'coordenador'
  ),
  (
    '82000000-0000-0000-0000-000000000001',
    '81000000-0000-0000-0000-000000000002',
    'pesquisador'
  );

INSERT INTO public.documents (id, project_id, title, text) VALUES
  (
    '83000000-0000-0000-0000-000000000001',
    '82000000-0000-0000-0000-000000000001',
    'response do backfill',
    'texto'
  );

INSERT INTO public.responses (
  id,
  project_id,
  document_id,
  respondent_id,
  respondent_type,
  answers,
  version_inferred_from
) VALUES (
  '84000000-0000-0000-0000-000000000001',
  '82000000-0000-0000-0000-000000000001',
  '83000000-0000-0000-0000-000000000001',
  '81000000-0000-0000-0000-000000000002',
  'humano',
  '{}',
  'created_at'
);

GRANT SELECT, UPDATE ON public.projects TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.schema_change_log TO authenticated;
GRANT SELECT, UPDATE ON public.responses TO authenticated;

CREATE TEMP TABLE schema_rpc_results (
  name text PRIMARY KEY,
  status text NOT NULL,
  revision bigint,
  fields jsonb,
  major int,
  minor int,
  patch int
);
GRANT SELECT, INSERT ON schema_rpc_results TO authenticated;

-- ----- ACL -----
DO $$
BEGIN
  IF NOT has_function_privilege(
    'authenticated',
    'public.commit_project_schema(uuid,bigint,jsonb,text,text,integer,integer,integer,text,jsonb,uuid)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'authenticated',
    'public.apply_schema_backfill(uuid,bigint,integer,integer,integer,jsonb,jsonb)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'FALHOU ACL: authenticated sem EXECUTE nas RPCs de schema';
  END IF;

  IF has_function_privilege(
    'anon',
    'public.commit_project_schema(uuid,bigint,jsonb,text,text,integer,integer,integer,text,jsonb,uuid)',
    'EXECUTE'
  ) OR has_function_privilege(
    'anon',
    'public.apply_schema_backfill(uuid,bigint,integer,integer,integer,jsonb,jsonb)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'FALHOU ACL: anon pode executar RPC de schema';
  END IF;

  RAISE NOTICE 'OK ACL: RPCs de schema não estão expostas a anon';
END;
$$;

-- ----- Commit feliz: projects e histórico entram juntos -----
SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"81000000-0000-0000-0000-000000000001"}',
  true
);
SET LOCAL ROLE authenticated;

INSERT INTO schema_rpc_results
SELECT 'commit-saved', result.*
FROM public.commit_project_schema(
  '82000000-0000-0000-0000-000000000001',
  0,
  '[{"name":"new_field"}]',
  'class Analysis: new',
  'hash-new',
  0,
  2,
  0,
  'minor',
  '[{"field_name":"new_field","change_summary":"adicionado","before_value":{},"after_value":{"name":"new_field"}}]',
  '81000000-0000-0000-0000-000000000001'
) AS result;

RESET ROLE;

DO $$
DECLARE
  v_result schema_rpc_results%ROWTYPE;
  v_log record;
BEGIN
  SELECT * INTO v_result
  FROM schema_rpc_results
  WHERE name = 'commit-saved';

  IF v_result.status <> 'saved'
     OR v_result.revision <> 1
     OR v_result.fields <> '[{"name":"new_field"}]'::jsonb
     OR (v_result.major, v_result.minor, v_result.patch) <> (0, 2, 0) THEN
    RAISE EXCEPTION 'FALHOU commit: retorno inesperado: %', row_to_json(v_result);
  END IF;

  SELECT changed_by, change_type, version_major, version_minor, version_patch
  INTO v_log
  FROM public.schema_change_log
  WHERE project_id = '82000000-0000-0000-0000-000000000001'
    AND field_name = 'new_field';

  IF v_log.changed_by <> '81000000-0000-0000-0000-000000000001'::uuid
     OR v_log.change_type <> 'minor'
     OR (v_log.version_major, v_log.version_minor, v_log.version_patch)
        <> (0, 2, 0) THEN
    RAISE EXCEPTION 'FALHOU commit: metadados do histórico não foram preenchidos pela RPC';
  END IF;

  RAISE NOTICE 'OK commit: schema, revisão e histórico foram persistidos atomicamente';
END;
$$;

-- ----- CAS stale: retorna conflito e não grava nada -----
SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"81000000-0000-0000-0000-000000000001"}',
  true
);
SET LOCAL ROLE authenticated;

INSERT INTO schema_rpc_results
SELECT 'commit-conflict', result.*
FROM public.commit_project_schema(
  '82000000-0000-0000-0000-000000000001',
  0,
  '[{"name":"stale_field"}]',
  'class Analysis: stale',
  'hash-stale',
  0,
  3,
  0,
  'minor',
  '[{"field_name":"stale_field","change_summary":"stale","before_value":{},"after_value":{}}]',
  '81000000-0000-0000-0000-000000000001'
) AS result;

RESET ROLE;

DO $$
DECLARE
  v_revision bigint;
  v_fields jsonb;
  v_log_count int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_rpc_results
    WHERE name = 'commit-conflict'
      AND status = 'conflict'
      AND revision = 1
      AND fields = '[{"name":"new_field"}]'::jsonb
  ) THEN
    RAISE EXCEPTION 'FALHOU CAS: snapshot corrente não retornado no conflito';
  END IF;

  SELECT schema_revision, pydantic_fields
  INTO v_revision, v_fields
  FROM public.projects
  WHERE id = '82000000-0000-0000-0000-000000000001';
  SELECT count(*) INTO v_log_count
  FROM public.schema_change_log
  WHERE project_id = '82000000-0000-0000-0000-000000000001';

  IF v_revision <> 1
     OR v_fields <> '[{"name":"new_field"}]'::jsonb
     OR v_log_count <> 1 THEN
    RAISE EXCEPTION 'FALHOU CAS: conflito stale produziu escrita';
  END IF;

  RAISE NOTICE 'OK CAS: revisão stale retornou conflito sem qualquer escrita';
END;
$$;

-- ----- Log inválido: o UPDATE anterior da mesma RPC sofre rollback -----
SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"81000000-0000-0000-0000-000000000001"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
BEGIN
  PERFORM *
  FROM public.commit_project_schema(
    '82000000-0000-0000-0000-000000000001',
    1,
    '{}',
    'class Analysis: malformed',
    'hash-malformed',
    0,
    3,
    0,
    'minor',
    '[{"field_name":"malformed","change_summary":"payload inválido","before_value":{},"after_value":{}}]',
    '81000000-0000-0000-0000-000000000001'
  );
  RAISE EXCEPTION 'TESTE FALHOU: fields não-array deveria ser rejeitado';
EXCEPTION
  WHEN invalid_parameter_value THEN
    RAISE NOTICE 'OK contrato: pydantic_fields não-array foi rejeitado';
END;
$$;

DO $$
BEGIN
  PERFORM *
  FROM public.commit_project_schema(
    '82000000-0000-0000-0000-000000000001',
    1,
    '[{"name":"must_rollback"}]',
    'class Analysis: must_rollback',
    'hash-must-rollback',
    0,
    3,
    0,
    'minor',
    '[{"change_summary":"field_name ausente","before_value":{},"after_value":{}}]',
    '81000000-0000-0000-0000-000000000001'
  );
  RAISE EXCEPTION 'TESTE FALHOU: log sem field_name deveria violar NOT NULL';
EXCEPTION
  WHEN not_null_violation THEN
    RAISE NOTICE 'OK rollback: log inválido abortou a chamada';
END;
$$;

DO $$
BEGIN
  PERFORM *
  FROM public.commit_project_schema(
    '82000000-0000-0000-0000-000000000001',
    1,
    '[{"name":"without_audit"}]',
    'class Analysis: without_audit',
    'hash-without-audit',
    0,
    3,
    0,
    'minor',
    '[]',
    '81000000-0000-0000-0000-000000000001'
  );
  RAISE EXCEPTION 'TESTE FALHOU: commit sem histórico deveria ser rejeitado';
EXCEPTION
  WHEN invalid_parameter_value THEN
    RAISE NOTICE 'OK auditoria: commit sem entradas de histórico foi rejeitado';
END;
$$;

RESET ROLE;

DO $$
DECLARE
  v_project record;
  v_log_count int;
BEGIN
  SELECT schema_revision, pydantic_fields, schema_version_minor
  INTO v_project
  FROM public.projects
  WHERE id = '82000000-0000-0000-0000-000000000001';
  SELECT count(*) INTO v_log_count
  FROM public.schema_change_log
  WHERE project_id = '82000000-0000-0000-0000-000000000001';

  IF v_project.schema_revision <> 1
     OR v_project.pydantic_fields <> '[{"name":"new_field"}]'::jsonb
     OR v_project.schema_version_minor <> 2
     OR v_log_count <> 1 THEN
    RAISE EXCEPTION 'FALHOU rollback: commit inválido ou sem auditoria reteve escrita';
  END IF;

  RAISE NOTICE 'OK rollback: falha ou ausência de histórico preservou schema e log';
END;
$$;

-- ----- RLS: pesquisador recebe forbidden; linha invisível recebe not_found -----
SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"81000000-0000-0000-0000-000000000002"}',
  true
);
SET LOCAL ROLE authenticated;

INSERT INTO schema_rpc_results
SELECT 'researcher-forbidden', result.*
FROM public.commit_project_schema(
  '82000000-0000-0000-0000-000000000001',
  1,
  '[{"name":"forbidden"}]',
  'forbidden',
  'forbidden',
  0,
  3,
  0,
  'minor',
  '[{"field_name":"forbidden","change_summary":"sem permissão","before_value":{},"after_value":{}}]',
  '81000000-0000-0000-0000-000000000002'
) AS result;

RESET ROLE;

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"81000000-0000-0000-0000-000000000003"}',
  true
);
SET LOCAL ROLE authenticated;

INSERT INTO schema_rpc_results
SELECT 'outsider-not-found', result.*
FROM public.commit_project_schema(
  '82000000-0000-0000-0000-000000000001',
  1,
  '[]',
  'not visible',
  'not-visible',
  0,
  3,
  0,
  'minor',
  '[{"field_name":"not_visible","change_summary":"sem acesso","before_value":{},"after_value":{}}]',
  '81000000-0000-0000-0000-000000000003'
) AS result;

RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_rpc_results
    WHERE name = 'researcher-forbidden' AND status = 'forbidden'
  ) OR NOT EXISTS (
    SELECT 1 FROM schema_rpc_results
    WHERE name = 'outsider-not-found' AND status = 'not_found'
  ) THEN
    RAISE EXCEPTION 'FALHOU RLS: statuses forbidden/not_found incorretos';
  END IF;

  IF (SELECT schema_revision FROM public.projects
      WHERE id = '82000000-0000-0000-0000-000000000001') <> 1 THEN
    RAISE EXCEPTION 'FALHOU RLS: chamada não autorizada alterou o projeto';
  END IF;

  RAISE NOTICE 'OK RLS: membro sem escrita e outsider receberam estados distintos';
END;
$$;

-- ----- Trigger: revisão e schema só podem avançar juntos -----
DO $$
BEGIN
  BEGIN
    UPDATE public.projects
    SET pydantic_code = 'mudança sem revisão'
    WHERE id = '82000000-0000-0000-0000-000000000002';
    RAISE EXCEPTION 'TESTE FALHOU: schema mudou sem revisão';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  BEGIN
    UPDATE public.projects
    SET schema_revision = 1
    WHERE id = '82000000-0000-0000-0000-000000000002';
    RAISE EXCEPTION 'TESTE FALHOU: revisão mudou isoladamente';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  UPDATE public.projects
  SET pydantic_hash = 'hash-runner'
  WHERE id = '82000000-0000-0000-0000-000000000002';

  UPDATE public.projects
  SET schema_version_patch = schema_version_patch + 1,
      schema_revision = schema_revision + 1
  WHERE id = '82000000-0000-0000-0000-000000000002';

  IF NOT EXISTS (
    SELECT 1 FROM public.projects
    WHERE id = '82000000-0000-0000-0000-000000000002'
      AND pydantic_hash = 'hash-runner'
      AND schema_revision = 1
      AND schema_version_patch = 1
  ) THEN
    RAISE EXCEPTION 'FALHOU trigger: caminhos válidos não foram preservados';
  END IF;

  RAISE NOTICE 'OK trigger: estado schema/revisão malformado é irrepresentável';
END;
$$;

-- ----- Backfill feliz: logs, responses e versão do projeto numa transação -----
SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"81000000-0000-0000-0000-000000000001"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_log_id uuid;
  v_result record;
BEGIN
  SELECT id INTO v_log_id
  FROM public.schema_change_log
  WHERE project_id = '82000000-0000-0000-0000-000000000001'
    AND field_name = 'new_field';

  SELECT * INTO v_result
  FROM public.apply_schema_backfill(
    '82000000-0000-0000-0000-000000000001',
    1,
    1,
    0,
    0,
    jsonb_build_array(jsonb_build_object(
      'id', v_log_id,
      'change_type', 'patch',
      'version_major', 1,
      'version_minor', 0,
      'version_patch', 0
    )),
    '[{"ids":["84000000-0000-0000-0000-000000000001"],"version_major":1,"version_minor":0,"version_patch":0,"version_inferred_from":"hashes"}]'
  );

  IF v_result.status <> 'saved'
     OR v_result.schema_revision <> 2
     OR (v_result.schema_version_major,
         v_result.schema_version_minor,
         v_result.schema_version_patch) <> (1, 0, 0) THEN
    RAISE EXCEPTION 'FALHOU backfill: retorno inesperado: %', row_to_json(v_result);
  END IF;
END;
$$;

RESET ROLE;

DO $$
DECLARE
  v_log record;
  v_response record;
BEGIN
  SELECT change_type, version_major, version_minor, version_patch
  INTO v_log
  FROM public.schema_change_log
  WHERE project_id = '82000000-0000-0000-0000-000000000001'
    AND field_name = 'new_field';
  SELECT schema_version_major, schema_version_minor, schema_version_patch,
         version_inferred_from
  INTO v_response
  FROM public.responses
  WHERE id = '84000000-0000-0000-0000-000000000001';

  IF v_log.change_type <> 'patch'
     OR (v_log.version_major, v_log.version_minor, v_log.version_patch)
        <> (1, 0, 0)
     OR (v_response.schema_version_major,
         v_response.schema_version_minor,
         v_response.schema_version_patch) <> (1, 0, 0)
     OR v_response.version_inferred_from <> 'hashes' THEN
    RAISE EXCEPTION 'FALHOU backfill: uma das três tabelas não foi atualizada';
  END IF;

  RAISE NOTICE 'OK backfill: histórico, resposta e projeto foram atualizados juntos';
END;
$$;

-- ----- Backfill inválido: contagem incompleta reverte tudo -----
SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"81000000-0000-0000-0000-000000000001"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_log_id uuid;
  v_failed boolean := false;
BEGIN
  SELECT id INTO v_log_id
  FROM public.schema_change_log
  WHERE project_id = '82000000-0000-0000-0000-000000000001'
    AND field_name = 'new_field';

  BEGIN
    PERFORM *
    FROM public.apply_schema_backfill(
      '82000000-0000-0000-0000-000000000001',
      2,
      2,
      0,
      0,
      jsonb_build_array(jsonb_build_object(
        'id', v_log_id,
        'change_type', 'major',
        'version_major', 2,
        'version_minor', 0,
        'version_patch', 0
      )),
      '[{"ids":["84000000-0000-0000-0000-000000000001","84000000-0000-0000-0000-000000000099"],"version_major":2,"version_minor":0,"version_patch":0,"version_inferred_from":"fallback_created_at"}]'
    );
  EXCEPTION
    WHEN raise_exception THEN
      v_failed := true;
  END;

  IF NOT v_failed THEN
    RAISE EXCEPTION 'TESTE FALHOU: response inexistente deveria abortar o backfill';
  END IF;

  RAISE NOTICE 'OK backfill rollback: mismatch de contagem abortou a chamada';
END;
$$;

RESET ROLE;

DO $$
DECLARE
  v_project record;
  v_log record;
  v_response record;
BEGIN
  SELECT schema_revision, schema_version_major, schema_version_minor,
         schema_version_patch
  INTO v_project
  FROM public.projects
  WHERE id = '82000000-0000-0000-0000-000000000001';
  SELECT change_type, version_major, version_minor, version_patch
  INTO v_log
  FROM public.schema_change_log
  WHERE project_id = '82000000-0000-0000-0000-000000000001'
    AND field_name = 'new_field';
  SELECT schema_version_major, schema_version_minor, schema_version_patch,
         version_inferred_from
  INTO v_response
  FROM public.responses
  WHERE id = '84000000-0000-0000-0000-000000000001';

  IF (v_project.schema_revision,
      v_project.schema_version_major,
      v_project.schema_version_minor,
      v_project.schema_version_patch) <> (2, 1, 0, 0)
     OR (v_log.change_type,
         v_log.version_major,
         v_log.version_minor,
         v_log.version_patch) <> ('patch', 1, 0, 0)
     OR (v_response.schema_version_major,
         v_response.schema_version_minor,
         v_response.schema_version_patch,
         v_response.version_inferred_from) <> (1, 0, 0, 'hashes') THEN
    RAISE EXCEPTION 'FALHOU backfill rollback: escrita parcial escapou da RPC';
  END IF;

  RAISE NOTICE 'OK backfill rollback: mismatch reverteu log e response; projeto permaneceu intacto';
END;
$$;

ROLLBACK;
