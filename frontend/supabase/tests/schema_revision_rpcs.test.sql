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
  ('81000000-0000-0000-0000-000000000003', 'schema-outsider@example.test'),
  ('81000000-0000-0000-0000-000000000004', 'schema-master@example.test');

-- O trigger on_auth_user_created espelha auth.users em profiles, e master_users
-- referencia profiles — por isso o INSERT abaixo só funciona depois dos usuários.
INSERT INTO public.master_users (user_id) VALUES
  ('81000000-0000-0000-0000-000000000004');

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
  ),
  (
    '82000000-0000-0000-0000-000000000004',
    'schema suggestion atomic test',
    '81000000-0000-0000-0000-000000000001',
    '[{"name":"suggested_field","type":"text","options":null,"description":"Antes"}]',
    'class Analysis: before',
    'hash-before'
  ),
  (
    '82000000-0000-0000-0000-000000000006',
    'schema master bypass test',
    '81000000-0000-0000-0000-000000000001',
    '[]',
    'class Analysis: pass',
    'hash-master'
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
  ),
  (
    '82000000-0000-0000-0000-000000000004',
    '81000000-0000-0000-0000-000000000001',
    'coordenador'
  ),
  (
    '82000000-0000-0000-0000-000000000004',
    '81000000-0000-0000-0000-000000000002',
    'pesquisador'
  );

INSERT INTO public.schema_suggestions (
  id,
  project_id,
  field_name,
  suggested_by,
  suggested_changes,
  reason
) VALUES (
  '85000000-0000-0000-0000-000000000001',
  '82000000-0000-0000-0000-000000000004',
  'suggested_field',
  '81000000-0000-0000-0000-000000000002',
  '{"description":"Depois"}',
  'melhorar descrição'
),
(
  -- Sugestão que permanece pendente: serve de sentinela para provar que uma
  -- aprovação recusada não resolve a sugestão como efeito colateral.
  '85000000-0000-0000-0000-000000000002',
  '82000000-0000-0000-0000-000000000004',
  'suggested_field',
  '81000000-0000-0000-0000-000000000002',
  '{"description":"Nunca aprovada"}',
  'sentinela de autorização'
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
) VALUES
  (
    '84000000-0000-0000-0000-000000000001',
    '82000000-0000-0000-0000-000000000001',
    '83000000-0000-0000-0000-000000000001',
    NULL,
    'llm',
    '{}',
    'created_at'
  ),
  (
    '84000000-0000-0000-0000-000000000002',
    '82000000-0000-0000-0000-000000000001',
    '83000000-0000-0000-0000-000000000001',
    NULL,
    'llm',
    '{}',
    'live_save'
  );

GRANT SELECT, UPDATE ON public.projects TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.schema_change_log TO authenticated;
GRANT SELECT, UPDATE ON public.responses TO authenticated;
GRANT SELECT, UPDATE ON public.schema_suggestions TO authenticated;
GRANT SELECT ON public.project_members TO authenticated;

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
    'public.commit_project_schema(uuid,bigint,jsonb,text,integer,integer,integer,text,jsonb,uuid)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'authenticated',
    'public.approve_schema_suggestion(uuid,uuid,bigint,jsonb,text,integer,integer,integer,text,jsonb,uuid)',
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
    'public.commit_project_schema(uuid,bigint,jsonb,text,integer,integer,integer,text,jsonb,uuid)',
    'EXECUTE'
  ) OR has_function_privilege(
    'anon',
    'public.approve_schema_suggestion(uuid,uuid,bigint,jsonb,text,integer,integer,integer,text,jsonb,uuid)',
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
  v_hash text;
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

  SELECT pydantic_hash INTO v_hash
  FROM public.projects
  WHERE id = '82000000-0000-0000-0000-000000000001';
  IF v_hash <> substring(
    encode(extensions.digest('class Analysis: new', 'sha256'), 'hex')
    FROM 1 FOR 16
  ) THEN
    RAISE EXCEPTION 'FALHOU commit: hash não foi derivado do código persistido';
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
    '[{"name":"invalid_semver"}]',
    'class Analysis: invalid_semver',
    9,
    0,
    0,
    'patch',
    '[{"field_name":"invalid_semver","change_summary":"salto inválido","before_value":{},"after_value":{}}]',
    '81000000-0000-0000-0000-000000000001'
  );
  RAISE EXCEPTION 'TESTE FALHOU: change_type incompatível com semver foi aceito';
EXCEPTION
  WHEN invalid_parameter_value THEN
    RAISE NOTICE 'OK semver: change_type precisa corresponder ao incremento exato';
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

-- Reordenar campos produzia exatamente este par: change_type 'patch' (a versão
-- avança) com log vazio (nenhum campo mudou de conteúdo). O par descreve um
-- estado incoerente — uma versão nova sem nada que explique a mudança —, e o
-- banco precisa recusá-lo por conta própria, independentemente de o frontend
-- ter parado de emiti-lo. Sem esta guarda, a mesma regressão volta silenciosa.
DO $$
BEGIN
  PERFORM *
  FROM public.commit_project_schema(
    '82000000-0000-0000-0000-000000000001',
    1,
    '[{"name":"new_field"},{"name":"reordered_field"}]',
    'class Analysis: reordered',
    0,
    2,
    1,
    'patch',
    '[]',
    '81000000-0000-0000-0000-000000000001'
  );
  RAISE EXCEPTION 'TESTE FALHOU: patch com log vazio deveria ser rejeitado';
EXCEPTION
  WHEN invalid_parameter_value THEN
    RAISE NOTICE 'OK auditoria: patch sem entradas de histórico foi rejeitado';
END;
$$;

-- `pydantic_hash` é derivado do código e de nada mais. Aceitar código nulo
-- gravaria hash nulo, que `compare-version.ts` interpreta como "projeto anterior
-- ao versionamento" — o schema recém-salvo seria lido como legado e a comparação
-- por versão passaria a mentir. Nulo não descreve nenhum estado legítimo, então
-- a RPC o recusa em vez de derivar hash de string vazia.
DO $$
BEGIN
  PERFORM *
  FROM public.commit_project_schema(
    '82000000-0000-0000-0000-000000000001',
    1,
    '[{"name":"null_code"}]',
    NULL,
    0,
    3,
    0,
    'minor',
    '[{"field_name":"null_code","change_summary":"código nulo","before_value":{},"after_value":{}}]',
    '81000000-0000-0000-0000-000000000001'
  );
  RAISE EXCEPTION 'TESTE FALHOU: pydantic_code nulo deveria ser rejeitado';
EXCEPTION
  WHEN invalid_parameter_value THEN
    RAISE NOTICE 'OK contrato: pydantic_code nulo foi rejeitado';
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
  0,
  3,
  0,
  'minor',
  '[{"field_name":"not_visible","change_summary":"sem acesso","before_value":{},"after_value":{}}]',
  '81000000-0000-0000-0000-000000000003'
) AS result;

RESET ROLE;

-- `p_changed_by` é atribuição de autoria: vira `schema_change_log.changed_by`, a
-- linha que o histórico exibe como responsável pela mudança. Como é parâmetro, e
-- não valor derivado do JWT, um coordenador legítimo poderia assinar a mudança
-- com o id de outra pessoa. A RPC amarra o parâmetro ao `clerk_uid()` da sessão
-- para que a autoria registrada não possa divergir de quem executou.
SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"81000000-0000-0000-0000-000000000001"}',
  true
);
SET LOCAL ROLE authenticated;

INSERT INTO schema_rpc_results
SELECT 'impersonation-forbidden', result.*
FROM public.commit_project_schema(
  '82000000-0000-0000-0000-000000000001',
  1,
  '[{"name":"impersonated"}]',
  'class Analysis: impersonated',
  0,
  3,
  0,
  'minor',
  '[{"field_name":"impersonated","change_summary":"autoria forjada","before_value":{},"after_value":{}}]',
  '81000000-0000-0000-0000-000000000002'
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

  IF NOT EXISTS (
    SELECT 1 FROM schema_rpc_results
    WHERE name = 'impersonation-forbidden' AND status = 'forbidden'
  ) THEN
    RAISE EXCEPTION 'FALHOU autoria: changed_by divergente do JWT foi aceito';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.schema_change_log
    WHERE project_id = '82000000-0000-0000-0000-000000000001'
      AND changed_by = '81000000-0000-0000-0000-000000000002'
  ) THEN
    RAISE EXCEPTION 'FALHOU autoria: histórico registrou autor forjado';
  END IF;

  IF (SELECT schema_revision FROM public.projects
      WHERE id = '82000000-0000-0000-0000-000000000001') <> 1 THEN
    RAISE EXCEPTION 'FALHOU RLS: chamada não autorizada alterou o projeto';
  END IF;

  RAISE NOTICE 'OK RLS: membro sem escrita e outsider receberam estados distintos';
  RAISE NOTICE 'OK autoria: changed_by não pode divergir do clerk_uid() da sessão';
END;
$$;

-- ----- Aprovação de sugestão: schema, log e status são atômicos -----
SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"81000000-0000-0000-0000-000000000001"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_result record;
BEGIN
  SELECT * INTO v_result
  FROM public.approve_schema_suggestion(
    '85000000-0000-0000-0000-000000000001',
    '82000000-0000-0000-0000-000000000004',
    0,
    '[{"name":"suggested_field","type":"text","options":null,"description":"Depois"}]',
    'class Analysis: after',
    0,
    1,
    1,
    'patch',
    '[{"field_name":"suggested_field","change_summary":"descrição","before_value":{"description":"Antes"},"after_value":{"description":"Depois"}}]',
    '81000000-0000-0000-0000-000000000001'
  );

  IF v_result.status <> 'saved' OR v_result.schema_revision <> 1 THEN
    RAISE EXCEPTION 'FALHOU sugestão atômica: retorno inesperado %', row_to_json(v_result);
  END IF;
END;
$$;

RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.projects
    WHERE id = '82000000-0000-0000-0000-000000000004'
      AND schema_revision = 1
      AND schema_version_patch = 1
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.schema_suggestions
    WHERE id = '85000000-0000-0000-0000-000000000001'
      AND project_id = '82000000-0000-0000-0000-000000000004'
      AND status = 'approved'
      AND resolved_by = '81000000-0000-0000-0000-000000000001'
  ) THEN
    RAISE EXCEPTION 'FALHOU sugestão atômica: projeto e sugestão divergiram';
  END IF;
END;
$$;

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"81000000-0000-0000-0000-000000000001"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_failed boolean := false;
BEGIN
  BEGIN
    PERFORM *
    FROM public.approve_schema_suggestion(
      '85000000-0000-0000-0000-000000000099',
      '82000000-0000-0000-0000-000000000004',
      1,
      '[{"name":"suggested_field","type":"text","options":null,"description":"Não persistir"}]',
      'class Analysis: rollback',
      0,
      1,
      2,
      'patch',
      '[{"field_name":"rollback","change_summary":"não persistir","before_value":{},"after_value":{}}]',
      '81000000-0000-0000-0000-000000000001'
    );
  EXCEPTION
    WHEN raise_exception THEN
      v_failed := true;
  END;

  IF NOT v_failed THEN
    RAISE EXCEPTION 'TESTE FALHOU: sugestão inexistente deveria abortar';
  END IF;
END;
$$;

RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.projects
    WHERE id = '82000000-0000-0000-0000-000000000004'
      AND schema_revision = 1
      AND schema_version_patch = 1
      AND pydantic_fields->0->>'description' = 'Depois'
  ) OR EXISTS (
    SELECT 1
    FROM public.schema_change_log
    WHERE project_id = '82000000-0000-0000-0000-000000000004'
      AND field_name = 'rollback'
  ) THEN
    RAISE EXCEPTION 'FALHOU sugestão rollback: escrita parcial escapou';
  END IF;

  RAISE NOTICE 'OK sugestão atômica: falha ao resolver reverteu schema e log';
END;
$$;

-- approve_schema_suggestion delega a autorização ao commit canônico, e propaga o
-- status dele em vez de levantar exceção. A ordem importa: o commit precisa
-- recusar ANTES do UPDATE da sugestão, senão um pesquisador conseguiria resolver
-- a sugestão de outrem — marcá-la como aprovada sem poder aplicar o schema — e a
-- fila de sugestões perderia o item sem nenhuma mudança correspondente.
SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"81000000-0000-0000-0000-000000000002"}',
  true
);
SET LOCAL ROLE authenticated;

INSERT INTO schema_rpc_results
SELECT 'approve-forbidden', result.*
FROM public.approve_schema_suggestion(
  '85000000-0000-0000-0000-000000000002',
  '82000000-0000-0000-0000-000000000004',
  1,
  '[{"name":"suggested_field","type":"text","options":null,"description":"Nunca aprovada"}]',
  'class Analysis: forbidden',
  0,
  1,
  2,
  'patch',
  '[{"field_name":"suggested_field","change_summary":"sem permissão","before_value":{},"after_value":{}}]',
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
SELECT 'approve-not-found', result.*
FROM public.approve_schema_suggestion(
  '85000000-0000-0000-0000-000000000002',
  '82000000-0000-0000-0000-000000000004',
  1,
  '[{"name":"suggested_field","type":"text","options":null,"description":"Nunca aprovada"}]',
  'class Analysis: not_found',
  0,
  1,
  2,
  'patch',
  '[{"field_name":"suggested_field","change_summary":"sem acesso","before_value":{},"after_value":{}}]',
  '81000000-0000-0000-0000-000000000003'
) AS result;

RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_rpc_results
    WHERE name = 'approve-forbidden' AND status = 'forbidden'
  ) OR NOT EXISTS (
    SELECT 1 FROM schema_rpc_results
    WHERE name = 'approve-not-found' AND status = 'not_found'
  ) THEN
    RAISE EXCEPTION 'FALHOU sugestão RLS: statuses forbidden/not_found incorretos';
  END IF;

  -- A sentinela continua pendente: nenhuma das duas chamadas recusadas resolveu
  -- a sugestão como efeito colateral do commit negado.
  IF NOT EXISTS (
    SELECT 1
    FROM public.schema_suggestions
    WHERE id = '85000000-0000-0000-0000-000000000002'
      AND status = 'pending'
      AND resolved_by IS NULL
  ) THEN
    RAISE EXCEPTION 'FALHOU sugestão RLS: aprovação recusada resolveu a sugestão';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.projects
    WHERE id = '82000000-0000-0000-0000-000000000004'
      AND schema_revision = 1
      AND schema_version_patch = 1
  ) THEN
    RAISE EXCEPTION 'FALHOU sugestão RLS: chamada recusada alterou o projeto';
  END IF;

  RAISE NOTICE 'OK sugestão RLS: recusa precede a resolução e preserva a fila';
END;
$$;

-- ----- Master ignora a fronteira de coordenador, mas não a de autoria -----
-- is_master() é o bypass de super-admin da plataforma: o master não é criador nem
-- membro do projeto 006, e ainda assim precisa conseguir commitar — é o caminho
-- de manutenção. O teste fixa que o bypass atravessa a checagem explícita da RPC
-- E as policies de projects/schema_change_log; se qualquer uma perder o
-- `OR is_master()`, o commit para de funcionar aqui em vez de em produção.
SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"81000000-0000-0000-0000-000000000004"}',
  true
);
SET LOCAL ROLE authenticated;

INSERT INTO schema_rpc_results
SELECT 'master-saved', result.*
FROM public.commit_project_schema(
  '82000000-0000-0000-0000-000000000006',
  0,
  '[{"name":"master_field"}]',
  'class Analysis: master',
  0,
  2,
  0,
  'minor',
  '[{"field_name":"master_field","change_summary":"manutenção do master","before_value":{},"after_value":{"name":"master_field"}}]',
  '81000000-0000-0000-0000-000000000004'
) AS result;

RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_rpc_results
    WHERE name = 'master-saved'
      AND status = 'saved'
      AND revision = 1
      AND (major, minor, patch) = (0, 2, 0)
  ) THEN
    RAISE EXCEPTION 'FALHOU master: bypass não commitou projeto de terceiro';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.schema_change_log
    WHERE project_id = '82000000-0000-0000-0000-000000000006'
      AND field_name = 'master_field'
      AND changed_by = '81000000-0000-0000-0000-000000000004'
  ) THEN
    RAISE EXCEPTION 'FALHOU master: histórico do commit do master não foi gravado';
  END IF;

  RAISE NOTICE 'OK master: bypass commita projeto onde não é membro nem criador';
END;
$$;

-- ----- Trigger: revisão e schema só podem avançar juntos -----
DO $$
BEGIN
  BEGIN
    INSERT INTO public.projects (id, name, created_by, schema_revision)
    VALUES (
      '82000000-0000-0000-0000-000000000003',
      'schema revision negativa',
      '81000000-0000-0000-0000-000000000001',
      -1
    );
    RAISE EXCEPTION 'TESTE FALHOU: INSERT aceitou revisão negativa';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  BEGIN
    INSERT INTO public.projects (id, name, created_by, pydantic_fields)
    VALUES (
      '82000000-0000-0000-0000-000000000005',
      'schema fields nulo',
      '81000000-0000-0000-0000-000000000001',
      NULL
    );
    RAISE EXCEPTION 'TESTE FALHOU: projeto aceitou pydantic_fields nulo';
  EXCEPTION
    WHEN not_null_violation THEN
      NULL;
  END;

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

-- ----- Backfill sem histórico não pode alterar a versão -----
SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"81000000-0000-0000-0000-000000000001"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
BEGIN
  PERFORM *
  FROM public.apply_schema_backfill(
    '82000000-0000-0000-0000-000000000001',
    1,
    1,
    0,
    0,
    '[]',
    '[]'
  );
  RAISE EXCEPTION 'TESTE FALHOU: backfill sem histórico alterou a versão';
EXCEPTION
  WHEN invalid_parameter_value THEN
    RAISE NOTICE 'OK backfill: mudança de versão exige histórico reconstruído';
END;
$$;

-- Os payloads do backfill são lidos por jsonb_to_recordset, que só aceita array.
-- Um objeto solto — o erro natural de quem monta o payload no frontend e esquece
-- de envolver a linha única numa lista — faria a leitura falhar com erro de tipo
-- genérico do Postgres, no meio da RPC e depois de já ter travado o projeto.
-- A validação antecipada converte isso num contrato explícito, recusado antes de
-- qualquer leitura de estado.
DO $$
BEGIN
  PERFORM *
  FROM public.apply_schema_backfill(
    '82000000-0000-0000-0000-000000000001',
    1,
    1,
    0,
    0,
    '{"id":"84000000-0000-0000-0000-000000000001"}',
    '[]'
  );
  RAISE EXCEPTION 'TESTE FALHOU: p_log_updates não-array foi aceito';
EXCEPTION
  WHEN invalid_parameter_value THEN
    RAISE NOTICE 'OK backfill: p_log_updates não-array foi rejeitado';
END;
$$;

DO $$
BEGIN
  PERFORM *
  FROM public.apply_schema_backfill(
    '82000000-0000-0000-0000-000000000001',
    1,
    1,
    0,
    0,
    '[]',
    '{"ids":["84000000-0000-0000-0000-000000000001"]}'
  );
  RAISE EXCEPTION 'TESTE FALHOU: p_response_updates não-array foi aceito';
EXCEPTION
  WHEN invalid_parameter_value THEN
    RAISE NOTICE 'OK backfill: p_response_updates não-array foi rejeitado';
END;
$$;

RESET ROLE;

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

-- ----- Backfill stale e sem permissão não tocam nenhuma tabela -----
SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"81000000-0000-0000-0000-000000000001"}',
  true
);
SET LOCAL ROLE authenticated;

INSERT INTO schema_rpc_results
SELECT 'backfill-conflict', result.*
FROM public.apply_schema_backfill(
  '82000000-0000-0000-0000-000000000001',
  1,
  2,
  0,
  0,
  '[]',
  '[]'
) AS result;

RESET ROLE;

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"81000000-0000-0000-0000-000000000002"}',
  true
);
SET LOCAL ROLE authenticated;

INSERT INTO schema_rpc_results
SELECT 'backfill-forbidden', result.*
FROM public.apply_schema_backfill(
  '82000000-0000-0000-0000-000000000001',
  2,
  1,
  0,
  0,
  '[]',
  '[]'
) AS result;

RESET ROLE;

DO $$
DECLARE
  v_project record;
  v_log record;
  v_response record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_rpc_results
    WHERE name = 'backfill-conflict' AND status = 'conflict' AND revision = 2
  ) OR NOT EXISTS (
    SELECT 1 FROM schema_rpc_results
    WHERE name = 'backfill-forbidden' AND status = 'forbidden'
  ) THEN
    RAISE EXCEPTION 'FALHOU backfill: CAS/RLS retornaram status incorreto';
  END IF;

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
    RAISE EXCEPTION 'FALHOU backfill: conflito ou RLS produziu escrita';
  END IF;

  RAISE NOTICE 'OK backfill CAS/RLS: chamadas recusadas não tocaram as três tabelas';
END;
$$;

-- Um payload parcial com IDs válidos não pode finalizar o backfill.
INSERT INTO public.schema_change_log (
  project_id,
  changed_by,
  field_name,
  change_summary,
  before_value,
  after_value
) VALUES (
  '82000000-0000-0000-0000-000000000001',
  '81000000-0000-0000-0000-000000000001',
  'second_field',
  'segundo log para cobertura',
  '{}',
  '{"name":"second_field"}'
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
  '84000000-0000-0000-0000-000000000003',
  '82000000-0000-0000-0000-000000000001',
  '83000000-0000-0000-0000-000000000001',
  NULL,
  'llm',
  '{}',
  'created_at'
);

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
  EXCEPTION
    WHEN raise_exception THEN
      v_failed := true;
  END;

  IF NOT v_failed THEN
    RAISE EXCEPTION 'TESTE FALHOU: payload parcial deveria abortar o backfill';
  END IF;

  RAISE NOTICE 'OK backfill cobertura: payload parcial foi rejeitado';
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

-- ----- IDs repetidos: a contagem de cobertura não pode ser inflada -----
-- O backfill se autoriza contando: exige que o número de linhas pedidas bata com
-- o número atualizado (nada ficou de fora) e com o total do projeto (cobertura
-- completa). Um id repetido satisfaz as duas contagens sem cobrir a linha que
-- falta — o UPDATE casa o mesmo id duas vezes, `count(*)` sobe para 2, e uma
-- linha real fica com versão antiga enquanto a RPC declara 'saved'. Comparar
-- count(DISTINCT id) com count(*) fecha essa brecha antes das contagens.
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

  -- Dois logs existem no projeto; repetir um deles cobriria a contagem de 2 sem
  -- jamais tocar em `second_field`.
  BEGIN
    PERFORM *
    FROM public.apply_schema_backfill(
      '82000000-0000-0000-0000-000000000001',
      2,
      1,
      0,
      0,
      jsonb_build_array(
        jsonb_build_object(
          'id', v_log_id,
          'change_type', 'patch',
          'version_major', 1,
          'version_minor', 0,
          'version_patch', 0
        ),
        jsonb_build_object(
          'id', v_log_id,
          'change_type', 'minor',
          'version_major', 1,
          'version_minor', 0,
          'version_patch', 0
        )
      ),
      '[]'
    );
  EXCEPTION
    WHEN invalid_parameter_value THEN
      v_failed := true;
  END;

  IF NOT v_failed THEN
    RAISE EXCEPTION 'TESTE FALHOU: ids de log repetidos deveriam ser rejeitados';
  END IF;

  RAISE NOTICE 'OK backfill: ids de log repetidos não inflam a cobertura';
END;
$$;

DO $$
DECLARE
  v_new_field_log uuid;
  v_second_field_log uuid;
  v_failed boolean := false;
BEGIN
  SELECT id INTO v_new_field_log
  FROM public.schema_change_log
  WHERE project_id = '82000000-0000-0000-0000-000000000001'
    AND field_name = 'new_field';
  SELECT id INTO v_second_field_log
  FROM public.schema_change_log
  WHERE project_id = '82000000-0000-0000-0000-000000000001'
    AND field_name = 'second_field';

  -- Os logs vão completos e válidos para que a rejeição só possa vir do lado das
  -- responses. O mesmo id aparece em dois buckets com versões divergentes — o
  -- formato exato que um agrupamento furado no frontend produziria, e cuja
  -- gravação deixaria a versão final da resposta dependente da ordem do UPDATE.
  BEGIN
    PERFORM *
    FROM public.apply_schema_backfill(
      '82000000-0000-0000-0000-000000000001',
      2,
      1,
      0,
      0,
      jsonb_build_array(
        jsonb_build_object(
          'id', v_new_field_log,
          'change_type', 'patch',
          'version_major', 1,
          'version_minor', 0,
          'version_patch', 0
        ),
        jsonb_build_object(
          'id', v_second_field_log,
          'change_type', 'patch',
          'version_major', 1,
          'version_minor', 0,
          'version_patch', 0
        )
      ),
      '[{"ids":["84000000-0000-0000-0000-000000000001"],"version_major":1,"version_minor":0,"version_patch":0,"version_inferred_from":"hashes"},
        {"ids":["84000000-0000-0000-0000-000000000001"],"version_major":0,"version_minor":1,"version_patch":0,"version_inferred_from":"created_at"}]'
    );
  EXCEPTION
    WHEN invalid_parameter_value THEN
      v_failed := true;
  END;

  IF NOT v_failed THEN
    RAISE EXCEPTION 'TESTE FALHOU: ids de response repetidos deveriam ser rejeitados';
  END IF;

  RAISE NOTICE 'OK backfill: ids de response repetidos não inflam a cobertura';
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
    RAISE EXCEPTION 'FALHOU backfill duplicatas: payload repetido produziu escrita';
  END IF;

  RAISE NOTICE 'OK backfill duplicatas: rejeição por id repetido não tocou as três tabelas';
END;
$$;

ROLLBACK;
