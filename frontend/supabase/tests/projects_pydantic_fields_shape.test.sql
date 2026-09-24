-- Contrato da CHECK projects_pydantic_fields_shape (migration
-- 20260924130000_pydantic_field_ids): todo campo de projects.pydantic_fields
-- tem `id` UUID na forma canonica (hifens e minusculas), sem id nem nome
-- repetido dentro do array.
--
-- Cada caso isola uma clausula de pydantic_fields_shape_valid: o id em caixa
-- alta cai so na regex, e o id repetido em minusculas cai so na contagem de
-- distintos. Cada UPDATE bumpa schema_revision, para que a unica recusa
-- possivel venha da constraint, e o SQLERRM e conferido pelo nome dela.
--
-- Como rodar (apos `npx supabase start` e `npx supabase db reset`):
--   bash scripts/run-sql-test.sh supabase/tests/projects_pydantic_fields_shape.test.sql
--
-- Roda inteiro em BEGIN ... ROLLBACK; nao deixa fixtures no banco local.

BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('7c000000-0000-0000-0000-000000000001', 'fields-shape@example.test');

INSERT INTO public.clerk_user_mapping
  (clerk_user_id, supabase_user_id, access_sync_version)
VALUES
  ('7c000000-0000-0000-0000-000000000001',
   '7c000000-0000-0000-0000-000000000001', 1);

INSERT INTO public.projects (id, name, created_by, pydantic_fields) VALUES
  ('7c100000-0000-0000-0000-000000000001', 'fields shape',
   '7c000000-0000-0000-0000-000000000001', '[]');

DO $$
DECLARE
  bad RECORD;
BEGIN
  FOR bad IN SELECT * FROM (VALUES
    ('campo sem id',
     '[{"name":"sem_id"}]'::JSONB),
    ('id fora da forma canonica (caixa alta)',
     '[{"id":"00000000-0000-4000-8000-0000000000D1","name":"a"}]'::JSONB),
    ('id repetido',
     '[{"id":"00000000-0000-4000-8000-0000000000d1","name":"a"},
       {"id":"00000000-0000-4000-8000-0000000000d1","name":"b"}]'::JSONB),
    ('nome repetido',
     '[{"id":"00000000-0000-4000-8000-0000000000e1","name":"dup"},
       {"id":"00000000-0000-4000-8000-0000000000e2","name":"dup"}]'::JSONB)
  ) AS v(caso, fields) LOOP
    BEGIN
      UPDATE public.projects
      SET pydantic_fields = bad.fields, schema_revision = schema_revision + 1
      WHERE id = '7c100000-0000-0000-0000-000000000001';
      RAISE EXCEPTION 'FALHOU: % foi aceito', bad.caso;
    EXCEPTION
      WHEN check_violation THEN
        IF SQLERRM NOT LIKE '%projects_pydantic_fields_shape%' THEN
          RAISE;
        END IF;
    END;
  END LOOP;

  -- O caminho valido segue aceito: ids distintos e canonicos, e array vazio.
  UPDATE public.projects
  SET pydantic_fields =
        '[{"id":"00000000-0000-4000-8000-0000000000f1","name":"a"},
          {"id":"00000000-0000-4000-8000-0000000000f2","name":"b"}]',
      schema_revision = schema_revision + 1
  WHERE id = '7c100000-0000-0000-0000-000000000001';
  UPDATE public.projects
  SET pydantic_fields = '[]', schema_revision = schema_revision + 1
  WHERE id = '7c100000-0000-0000-0000-000000000001';

  RAISE NOTICE 'OK: shape de pydantic_fields';
END;
$$;

ROLLBACK;
