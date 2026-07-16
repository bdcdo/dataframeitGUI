-- Contratos atômicos das RPCs administrativas de documentos e versões.
--
-- Como rodar (após `npx supabase db reset`):
--   docker exec -i supabase_db_frontend psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/atomic_replace_rpcs.test.sql
--
-- Todas as fixtures e grants são revertidos. Este arquivo é autocontido: não
-- pressupõe alias RLS nem remoção atômica de ex-membro.

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_rejected(
  statement text,
  label text,
  expected_sqlstate text,
  expected_message_pattern text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  actual_sqlstate text;
  actual_message text;
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS
      actual_sqlstate = RETURNED_SQLSTATE,
      actual_message = MESSAGE_TEXT;

    IF actual_sqlstate IS DISTINCT FROM expected_sqlstate THEN
      RAISE EXCEPTION
        'rejeição incorreta em %: esperado SQLSTATE %, recebido % (%)',
        label, expected_sqlstate, actual_sqlstate, actual_message;
    END IF;

    IF expected_message_pattern IS NOT NULL
       AND actual_message NOT LIKE expected_message_pattern THEN
      RAISE EXCEPTION
        'mensagem incorreta em %: esperado LIKE %, recebido %',
        label, expected_message_pattern, actual_message;
    END IF;

    RETURN;
  END;

  RAISE EXCEPTION 'esperava rejeição em %, mas o statement foi aceito', label;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.assert_integer_result(
  statement text,
  expected_result integer,
  label text
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  actual_result integer;
BEGIN
  EXECUTE statement INTO actual_result;
  IF actual_result IS DISTINCT FROM expected_result THEN
    RAISE EXCEPTION
      'resultado incorreto em %: esperado %, recebido %',
      label, expected_result, actual_result;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION pg_temp.assert_rejected(text, text, text, text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.assert_integer_result(text, integer, text)
  TO authenticated;

-- ========== Fixtures ==========

INSERT INTO auth.users (id, email) VALUES
  ('77777777-7777-7777-7777-777777777771', 'atomic-coord@example.test'),
  ('77777777-7777-7777-7777-777777777772', 'atomic-member@example.test'),
  ('88888888-8888-8888-8888-888888888888', 'atomic-outsider@example.test'),
  ('99999999-9999-9999-9999-999999999999', 'atomic-other@example.test');

INSERT INTO public.projects (
  id, name, created_by, pydantic_hash, pydantic_fields,
  schema_version_major, schema_version_minor, schema_version_patch
) VALUES
  (
    '11111111-1111-1111-1111-111111111111', 'Projeto atômico A',
    '77777777-7777-7777-7777-777777777771', 'schema-a',
    '[{"name":"campo","hash":"hash-a"}]', 0, 1, 0
  ),
  (
    '11111111-1111-1111-1111-111111111112', 'Projeto atômico B',
    '99999999-9999-9999-9999-999999999999', 'schema-b',
    '[{"name":"campo","hash":"hash-b"}]', 4, 5, 6
  );

INSERT INTO public.project_members (project_id, user_id, role) VALUES
  (
    '11111111-1111-1111-1111-111111111111',
    '77777777-7777-7777-7777-777777777771', 'coordenador'
  ),
  (
    '11111111-1111-1111-1111-111111111111',
    '77777777-7777-7777-7777-777777777772', 'pesquisador'
  );

INSERT INTO public.documents (
  id, project_id, external_id, title, text, text_hash
) VALUES
  (
    '22222222-2222-2222-2222-222222222221',
    '11111111-1111-1111-1111-111111111111', NULL,
    'Documento alvo', 'texto alvo', 'hash-alvo'
  ),
  (
    '22222222-2222-2222-2222-222222222222',
    '11111111-1111-1111-1111-111111111111', 'EXISTING',
    'Documento com external_id', 'texto existente', 'hash-existente'
  ),
  (
    '22222222-2222-2222-2222-222222222223',
    '11111111-1111-1111-1111-111111111111', 'LOTTERY-OLD',
    'Documento sorteio antigo', 'texto', 'hash-lottery-old'
  ),
  (
    '22222222-2222-2222-2222-222222222224',
    '11111111-1111-1111-1111-111111111111', 'LOTTERY-NEW',
    'Documento sorteio novo', 'texto', 'hash-lottery-new'
  ),
  (
    '22222222-2222-2222-2222-222222222229',
    '11111111-1111-1111-1111-111111111112', 'OTHER',
    'Documento de outro projeto', 'texto outro', 'hash-outro'
  );

INSERT INTO public.responses (
  id, project_id, document_id, respondent_id, respondent_type,
  respondent_name, answers, is_latest, pydantic_hash,
  schema_version_major, schema_version_minor, schema_version_patch,
  version_inferred_from, answer_field_hashes
) VALUES
  (
    '44444444-4444-4444-4444-444444444441',
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222221',
    '77777777-7777-7777-7777-777777777772', 'humano', 'Membro',
    '{"campo":"x"}', true, 'schema-a', 0, 1, 0, 'live_save',
    '{"campo":"hash-a"}'
  ),
  (
    '44444444-4444-4444-4444-444444444449',
    '11111111-1111-1111-1111-111111111112',
    '22222222-2222-2222-2222-222222222229',
    '99999999-9999-9999-9999-999999999999', 'humano', 'Outro',
    '{"campo":"y"}', true, 'schema-b', 4, 5, 6, 'live_save',
    '{"campo":"hash-b"}'
  );

INSERT INTO public.reviews (
  id, project_id, document_id, field_name, reviewer_id, verdict
) VALUES (
  '55555555-5555-5555-5555-555555555551',
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222221', 'campo',
  '77777777-7777-7777-7777-777777777772', 'concordo'
);

INSERT INTO public.assignments (
  id, project_id, document_id, user_id, status, type
) VALUES
  (
    '66666666-6666-6666-6666-666666666661',
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222221',
    '77777777-7777-7777-7777-777777777772', 'concluido', 'codificacao'
  ),
  (
    '66666666-6666-6666-6666-666666666662',
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222223',
    '77777777-7777-7777-7777-777777777772', 'pendente', 'comparacao'
  ),
  (
    '66666666-6666-6666-6666-666666666663',
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222221',
    '77777777-7777-7777-7777-777777777772', 'concluido', 'comparacao'
  );

-- O teste concede apenas o acesso de tabela necessário ao caminho invoker da
-- loteria. As RPCs administrativas novas devem funcionar exclusivamente por
-- seus próprios grants SECURITY DEFINER.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assignments TO authenticated;
GRANT SELECT ON
  public.projects, public.project_members, public.documents
TO authenticated;

-- ========== replace_and_add_documents ==========

-- Outsider recebe erro explícito: uma função definer nunca pode confundir
-- falta de autorização com sucesso de rowcount zero.
SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"88888888-8888-8888-8888-888888888888"}', true
);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.replace_and_add_documents(
      '11111111-1111-1111-1111-111111111111',
      ARRAY['22222222-2222-2222-2222-222222222221'::uuid],
      true, '[]', '[]'
    )
  $sql$,
  'outsider replace_and_add_documents',
  '42501',
  '%coordinator%'
);
RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM public.responses
       WHERE id = '44444444-4444-4444-4444-444444444441'
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.reviews
       WHERE id = '55555555-5555-5555-5555-555555555551'
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.assignments
       WHERE id = '66666666-6666-6666-6666-666666666661'
         AND status = 'concluido'
     ) THEN
    RAISE EXCEPTION 'outsider alterou estado antes da rejeição';
  END IF;
END;
$$;

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"77777777-7777-7777-7777-777777777771"}', true
);
SET LOCAL ROLE authenticated;

-- Falha no INSERT precisa reverter DELETEs e reset anteriores.
SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.replace_and_add_documents(
      '11111111-1111-1111-1111-111111111111',
      ARRAY['22222222-2222-2222-2222-222222222221'::uuid],
      true,
      '[]',
      '[{"external_id":"EXISTING","title":"colide","text":"y","text_hash":"hash-new","metadata":null}]'
    )
  $sql$,
  'rollback em unique_violation do INSERT',
  '23505',
  '%duplicate key%'
);

-- IDs de outro projeto são rejeitados antes de qualquer escrita.
SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.replace_and_add_documents(
      '11111111-1111-1111-1111-111111111111',
      ARRAY[
        '22222222-2222-2222-2222-222222222221'::uuid,
        '22222222-2222-2222-2222-222222222229'::uuid
      ],
      true, '[]', '[]'
    )
  $sql$,
  'replace com documento cross-project',
  '23503',
  '%document ids must belong%'
);
RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM public.responses
       WHERE id = '44444444-4444-4444-4444-444444444441'
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.reviews
       WHERE id = '55555555-5555-5555-5555-555555555551'
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.assignments
       WHERE id = '66666666-6666-6666-6666-666666666661'
         AND status = 'concluido'
     ) THEN
    RAISE EXCEPTION 'falha atômica deixou mutação parcial';
  END IF;

  RAISE NOTICE 'OK replace: outsider, cross-project e rollback preservam estado';
END;
$$;

-- ========== rollback da loteria ==========

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"77777777-7777-7777-7777-777777777771"}', true
);
SET LOCAL ROLE authenticated;

SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.apply_lottery_assignments(
      '11111111-1111-1111-1111-111111111111',
      'comparacao', NULL,
      '[{
        "document_id":"22222222-2222-2222-2222-222222222221",
        "user_id":"77777777-7777-7777-7777-777777777772"
      }]',
      true,
      '[{
        "user_id":"77777777-7777-7777-7777-777777777772",
        "assignment_weight":2,
        "assignment_cap":3
      }]'
    )
  $sql$,
  'rollback da loteria após delete de pendências',
  '23505',
  '%duplicate key%'
);
RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM public.assignments
       WHERE id = '66666666-6666-6666-6666-666666666662'
         AND status = 'pendente'
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.project_members
       WHERE project_id = '11111111-1111-1111-1111-111111111111'
         AND user_id = '77777777-7777-7777-7777-777777777772'
         AND assignment_weight = 1
         AND assignment_cap IS NULL
     ) THEN
    RAISE EXCEPTION 'falha da loteria deixou mutação parcial';
  END IF;
END;
$$;

-- ========== set_response_schema_versions ==========

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"77777777-7777-7777-7777-777777777771"}', true
);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_integer_result(
  $sql$
    SELECT public.set_response_schema_versions(
      '11111111-1111-1111-1111-111111111111',
      '[{
        "id":"44444444-4444-4444-4444-444444444441",
        "schema_version_major":9,
        "schema_version_minor":8,
        "schema_version_patch":7,
        "version_inferred_from":"hashes"
      }]'
    )
  $sql$,
  1,
  'backfill de versão autorizado'
);

SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.set_response_schema_versions(
      '11111111-1111-1111-1111-111111111111',
      '[{
        "id":"44444444-4444-4444-4444-444444444449",
        "schema_version_major":1,
        "schema_version_minor":1,
        "schema_version_patch":1,
        "version_inferred_from":"cross_project"
      }]'
    )
  $sql$,
  'backfill com response cross-project',
  '23503',
  '%outside p_project_id%'
);

SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.set_response_schema_versions(
      '11111111-1111-1111-1111-111111111111',
      '[{
        "id":"44444444-4444-4444-4444-444444444441",
        "schema_version_major":null,
        "schema_version_minor":1,
        "schema_version_patch":1,
        "version_inferred_from":"invalid_null"
      }]'
    )
  $sql$,
  'backfill com componente de versão nulo',
  '22023', '%version components must be non-negative integers%'
);

SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.set_response_schema_versions(
      '11111111-1111-1111-1111-111111111111',
      '[{
        "id":"44444444-4444-4444-4444-444444444448",
        "schema_version_major":1,
        "schema_version_minor":1,
        "schema_version_patch":1,
        "version_inferred_from":"missing"
      }]'
    )
  $sql$,
  'backfill com response inexistente',
  '23503',
  '%outside p_project_id%'
);
RESET ROLE;

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"77777777-7777-7777-7777-777777777772"}', true
);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_rejected(
  $sql$
    SELECT public.set_response_schema_versions(
      '11111111-1111-1111-1111-111111111111',
      '[{
        "id":"44444444-4444-4444-4444-444444444441",
        "schema_version_major":2,
        "schema_version_minor":2,
        "schema_version_patch":2,
        "version_inferred_from":"unauthorized"
      }]'
    )
  $sql$,
  'pesquisador sem permissão de backfill',
  '42501',
  '%coordinator%'
);
RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.responses
    WHERE id = '44444444-4444-4444-4444-444444444441'
      AND schema_version_major = 9
      AND schema_version_minor = 8
      AND schema_version_patch = 7
      AND version_inferred_from = 'hashes'
  ) THEN
    RAISE EXCEPTION 'backfill autorizado não persistiu metadados esperados';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.responses
    WHERE id = '44444444-4444-4444-4444-444444444449'
      AND schema_version_major = 4
      AND schema_version_minor = 5
      AND schema_version_patch = 6
  ) THEN
    RAISE EXCEPTION 'backfill cross-project alterou response alheia';
  END IF;

  RAISE NOTICE 'OK versões: sucesso, autorização e validação integral de IDs';
END;
$$;

-- ========== Caminho feliz do replace ==========

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"77777777-7777-7777-7777-777777777771"}', true
);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_integer_result(
  $sql$
    SELECT public.replace_and_add_documents(
      '11111111-1111-1111-1111-111111111111',
      ARRAY['22222222-2222-2222-2222-222222222221'::uuid],
      true,
      '[]',
      '[{"external_id":"NEW-OK","title":"novo","text":"z","text_hash":"hash-ok","metadata":null}]'
    )
  $sql$,
  1,
  'replace administrativo autorizado'
);
RESET ROLE;

DO $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM public.responses
       WHERE id = '44444444-4444-4444-4444-444444444441'
     )
     OR EXISTS (
       SELECT 1 FROM public.reviews
       WHERE id = '55555555-5555-5555-5555-555555555551'
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.assignments
       WHERE id = '66666666-6666-6666-6666-666666666661'
         AND status = 'pendente'
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.documents
       WHERE project_id = '11111111-1111-1111-1111-111111111111'
         AND external_id = 'NEW-OK'
     ) THEN
    RAISE EXCEPTION 'replace autorizado não aplicou a transação completa';
  END IF;

  RAISE NOTICE 'OK replace: coordenador removeu dados alheios e reabriu assignment';
END;
$$;

-- ========== apply_lottery_assignments permanece atômica ==========

SELECT set_config(
  'request.jwt.claims',
  '{"supabase_uid":"77777777-7777-7777-7777-777777777771"}', true
);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_integer_result(
  $sql$
    SELECT public.apply_lottery_assignments(
      '11111111-1111-1111-1111-111111111111',
      'comparacao', NULL,
      '[{
        "document_id":"22222222-2222-2222-2222-222222222224",
        "user_id":"77777777-7777-7777-7777-777777777772"
      }]',
      true,
      '[{
        "user_id":"77777777-7777-7777-7777-777777777772",
        "assignment_weight":2.5,
        "assignment_cap":3
      }]'
    )
  $sql$,
  1,
  'loteria replace'
);
RESET ROLE;

DO $$
BEGIN
  IF (
    SELECT count(*) FROM public.assignments
    WHERE project_id = '11111111-1111-1111-1111-111111111111'
      AND type = 'comparacao'
      AND status = 'pendente'
  ) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.project_members
       WHERE project_id = '11111111-1111-1111-1111-111111111111'
         AND user_id = '77777777-7777-7777-7777-777777777772'
         AND assignment_weight = 2.5
         AND assignment_cap = 3
     ) THEN
    RAISE EXCEPTION 'loteria replace não deixou exatamente a nova pendência';
  END IF;
  RAISE NOTICE 'OK loteria: replace manteve o contrato atômico preexistente';
END;
$$;

ROLLBACK;
