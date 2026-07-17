-- Runtime contract for 20260715170000_llm_rate_limit.sql (#135).
--
-- Run after `npx supabase db reset`, via the shared runner (from frontend/):
--   ./scripts/run-sql-test.sh supabase/tests/llm_rate_limit.test.sql
--   # or the whole chain: npm run test:db
--
-- Do NOT run this file directly against the DB_URL from `supabase status`: that
-- URL points at 127.0.0.1, whose pg_hba route is trust, and dblink called by a
-- non-superuser is refused there ("password required"). The runner connects
-- over the container's routable IP (scram), which is why the dblink section
-- only passes through it.
--
-- The first transaction rolls back all ordinary fixtures. The concurrency
-- section uses two dblink sessions because one SQL session cannot prove the row
-- lock; its committed fixture is explicitly deleted after the final rollback.

-- Fora da transação, de propósito: o teardown roda após o ROLLBACK e ainda
-- precisa das funções de dblink — criada dentro do BEGIN, a extensão seria
-- desfeita junto num banco recém-resetado. Idempotente.
CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;

-- Auto-limpeza preventiva: os escritos das sessões dblink são commitados fora
-- da transação externa, então uma rodada anterior interrompida (deadlock,
-- kill, falha de teardown) deixa resíduo que quebraria o INSERT abaixo com
-- duplicate key. Idempotente num banco limpo.
DELETE FROM public.projects
  WHERE id = '55555555-5555-5555-5555-555555555135';
DELETE FROM auth.users
  WHERE id = '66666666-6666-6666-6666-666666666135';

BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('22222222-2222-2222-2222-222222222135', 'rate-user@example.test'),
  ('77777777-7777-7777-7777-777777777135', 'rate-service-role@example.test');

INSERT INTO public.projects (id, name, created_by) VALUES (
  '44444444-4444-4444-4444-444444444135',
  'rate limit test',
  '22222222-2222-2222-2222-222222222135'
);

DO $$
DECLARE
  v_allowed boolean;
  v_retry integer;
  v_result_rows integer;
  v_rows integer;
  v_count integer;
  v_bucket_user uuid;
BEGIN
  -- First dispatch creates the bucket; every allowed path reports retry_after 0.
  SELECT count(*), bool_and(allowed), min(retry_after_seconds)
  INTO v_result_rows, v_allowed, v_retry
  FROM public.consume_llm_rate_limit(
    '22222222-2222-2222-2222-222222222135',
    '44444444-4444-4444-4444-444444444135',
    3,
    60
  );
  IF v_result_rows <> 1 OR NOT v_allowed OR v_retry <> 0 THEN
    RAISE EXCEPTION 'first request must return exactly one allowed row with retry_after 0';
  END IF;

  -- Repeated dispatches from the same identity share one project bucket.
  SELECT allowed INTO v_allowed
  FROM public.consume_llm_rate_limit(
    '22222222-2222-2222-2222-222222222135',
    '44444444-4444-4444-4444-444444444135',
    3,
    60
  );
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'second request should be allowed';
  END IF;

  SELECT allowed INTO v_allowed
  FROM public.consume_llm_rate_limit(
    '22222222-2222-2222-2222-222222222135',
    '44444444-4444-4444-4444-444444444135',
    3,
    60
  );
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'third request should be allowed';
  END IF;

  SELECT allowed, retry_after_seconds INTO v_allowed, v_retry
  FROM public.consume_llm_rate_limit(
    '22222222-2222-2222-2222-222222222135',
    '44444444-4444-4444-4444-444444444135',
    3,
    60
  );
  IF v_allowed OR v_retry < 1 OR v_retry > 60 THEN
    RAISE EXCEPTION 'fourth request should be rejected with Retry-After';
  END IF;

  SELECT count(*), max(request_count), max(user_id::text)::uuid
  INTO v_rows, v_count, v_bucket_user
  FROM public.llm_rate_limit_buckets
  WHERE project_id = '44444444-4444-4444-4444-444444444135';
  IF v_rows <> 1 OR v_count <> 3 THEN
    RAISE EXCEPTION 'expected one bounded bucket at count 3, got rows=% count=%', v_rows, v_count;
  END IF;
  IF v_bucket_user <> '22222222-2222-2222-2222-222222222135' THEN
    RAISE EXCEPTION 'bucket did not key on the caller identity';
  END IF;
END $$;

-- Expire the fixed window without sleeping; the next request must reset to 1.
UPDATE public.llm_rate_limit_buckets
SET window_started_at = clock_timestamp() - interval '61 seconds',
    request_count = 3
WHERE project_id = '44444444-4444-4444-4444-444444444135';

DO $$
DECLARE
  v_allowed boolean;
  v_count integer;
  v_age interval;
BEGIN
  SELECT allowed INTO v_allowed
  FROM public.consume_llm_rate_limit(
    '22222222-2222-2222-2222-222222222135',
    '44444444-4444-4444-4444-444444444135',
    2,
    60
  );
  SELECT request_count, clock_timestamp() - window_started_at
  INTO v_count, v_age
  FROM public.llm_rate_limit_buckets
  WHERE project_id = '44444444-4444-4444-4444-444444444135';
  IF NOT v_allowed OR v_count <> 1 OR v_age >= interval '2 seconds' THEN
    RAISE EXCEPTION 'expired window did not reset atomically';
  END IF;
END $$;

-- The backend role can execute the RPC despite having no direct table grants;
-- SECURITY DEFINER is the only write boundary.
SET LOCAL ROLE service_role;
DO $$
DECLARE
  v_allowed boolean;
BEGIN
  SELECT allowed INTO v_allowed
  FROM public.consume_llm_rate_limit(
    '77777777-7777-7777-7777-777777777135',
    '44444444-4444-4444-4444-444444444135',
    1,
    60
  );
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'service_role RPC call should be allowed';
  END IF;
END $$;
RESET ROLE;

-- Bucket identities are profiles. Removing one must also remove its bucket;
-- otherwise a long-lived project would accumulate orphan counters forever.
DELETE FROM public.profiles
WHERE id = '77777777-7777-7777-7777-777777777135';
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.llm_rate_limit_buckets
    WHERE user_id = '77777777-7777-7777-7777-777777777135'
  ) THEN
    RAISE EXCEPTION 'profile deletion must cascade to its rate-limit bucket';
  END IF;
END $$;

DO $$
DECLARE
  v_rls boolean;
  v_security_definer boolean;
  v_search_path text;
BEGIN
  SELECT relrowsecurity INTO v_rls
  FROM pg_class
  WHERE oid = 'public.llm_rate_limit_buckets'::regclass;
  IF NOT v_rls THEN
    RAISE EXCEPTION 'RLS must be enabled on llm_rate_limit_buckets';
  END IF;

  IF has_table_privilege(
       'anon',
       'public.llm_rate_limit_buckets',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     ) OR has_table_privilege(
       'authenticated',
       'public.llm_rate_limit_buckets',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     ) OR has_table_privilege(
       'service_role',
       'public.llm_rate_limit_buckets',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     ) THEN
    RAISE EXCEPTION 'no runtime role may access the bucket table directly';
  END IF;

  IF has_function_privilege(
       'anon',
       'public.consume_llm_rate_limit(uuid,uuid,integer,integer)',
       'EXECUTE'
     ) OR has_function_privilege(
       'authenticated',
       'public.consume_llm_rate_limit(uuid,uuid,integer,integer)',
       'EXECUTE'
     ) OR NOT has_function_privilege(
       'service_role',
       'public.consume_llm_rate_limit(uuid,uuid,integer,integer)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'consume_llm_rate_limit must be service_role-only';
  END IF;

  SELECT prosecdef, array_to_string(proconfig, ',')
  INTO v_security_definer, v_search_path
  FROM pg_proc
  WHERE oid = 'public.consume_llm_rate_limit(uuid,uuid,integer,integer)'::regprocedure;
  IF NOT v_security_definer OR v_search_path <> 'search_path=""' THEN
    RAISE EXCEPTION 'RPC must be SECURITY DEFINER with an empty search_path';
  END IF;
END $$;

DO $$
BEGIN
  PERFORM public.consume_llm_rate_limit(
    '22222222-2222-2222-2222-222222222135',
    '44444444-4444-4444-4444-444444444135',
    0,
    60
  );
  RAISE EXCEPTION 'zero request limit should be rejected';
EXCEPTION
  WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%p_limit must be between%' THEN
      RAISE;
    END IF;
END $$;

-- Real two-session proof: session B remains blocked while session A owns the
-- new bucket row, then observes A's committed count and rejects at limit 1.
CREATE TEMP TABLE concurrent_results (
  session_name text PRIMARY KEY,
  allowed boolean NOT NULL,
  retry_after_seconds integer NOT NULL
) ON COMMIT DROP;

SELECT extensions.dblink_connect(
  'rate_limit_a',
  format(
    'hostaddr=%s port=%s dbname=%s user=postgres password=postgres',
    host(inet_server_addr()),
    inet_server_port(),
    current_database()
  )
);
SELECT extensions.dblink_connect(
  'rate_limit_b',
  format(
    'hostaddr=%s port=%s dbname=%s user=postgres password=postgres',
    host(inet_server_addr()),
    inet_server_port(),
    current_database()
  )
);

SELECT extensions.dblink_exec(
  'rate_limit_a',
  $$INSERT INTO auth.users (id, email)
    VALUES (
      '66666666-6666-6666-6666-666666666135',
      'rate-concurrency@example.test'
    )$$
);
SELECT extensions.dblink_exec(
  'rate_limit_a',
  $$INSERT INTO public.projects (id, name)
    VALUES (
      '55555555-5555-5555-5555-555555555135',
      'rate concurrency test'
    )$$
);
SELECT extensions.dblink_exec('rate_limit_a', 'BEGIN');

INSERT INTO concurrent_results
SELECT 'a', result.allowed, result.retry_after_seconds
FROM extensions.dblink(
  'rate_limit_a',
  $$SELECT allowed, retry_after_seconds
    FROM public.consume_llm_rate_limit(
      '66666666-6666-6666-6666-666666666135',
      '55555555-5555-5555-5555-555555555135',
      1,
      60
    )$$
) AS result(allowed boolean, retry_after_seconds integer);

SELECT extensions.dblink_send_query(
  'rate_limit_b',
  $$SELECT allowed, retry_after_seconds
    FROM public.consume_llm_rate_limit(
      '66666666-6666-6666-6666-666666666135',
      '55555555-5555-5555-5555-555555555135',
      1,
      60
    )$$
);
SELECT pg_sleep(0.2);

DO $$
BEGIN
  IF extensions.dblink_is_busy('rate_limit_b') <> 1 THEN
    RAISE EXCEPTION 'session B should wait on session A bucket lock';
  END IF;
END $$;

SELECT extensions.dblink_exec('rate_limit_a', 'COMMIT');

INSERT INTO concurrent_results
SELECT 'b', result.allowed, result.retry_after_seconds
FROM extensions.dblink_get_result('rate_limit_b')
  AS result(allowed boolean, retry_after_seconds integer);
-- libpq exposes a final empty PGresult after the tuple result. Drain it before
-- disconnecting; otherwise the async connection is left mid-command.
SELECT * FROM extensions.dblink_get_result('rate_limit_b')
  AS result(allowed boolean, retry_after_seconds integer);

DO $$
DECLARE
  v_a boolean;
  v_b boolean;
  v_rows integer;
  v_count integer;
BEGIN
  SELECT allowed INTO v_a FROM concurrent_results WHERE session_name = 'a';
  SELECT allowed INTO v_b FROM concurrent_results WHERE session_name = 'b';
  SELECT count(*), max(request_count) INTO v_rows, v_count
  FROM public.llm_rate_limit_buckets
  WHERE project_id = '55555555-5555-5555-5555-555555555135';
  IF NOT v_a OR v_b OR v_rows <> 1 OR v_count <> 1 THEN
    RAISE EXCEPTION 'concurrent calls were not serialized: a=% b=% rows=% count=%', v_a, v_b, v_rows, v_count;
  END IF;
END $$;

ROLLBACK;

-- Teardown DEPOIS do ROLLBACK externo, de propósito: as fixtures da transação
-- externa seguram o advisory lock global de identidade (triggers de
-- 20260716155000 em project_members/auth.users), e cada dblink_exec roda em
-- autocommit pedindo o MESMO lock — teardown dentro da transação externa é
-- deadlock que o Postgres não detecta (a espera atravessa o dblink). Com o
-- ROLLBACK antes, o lock já foi solto quando as deleções rodam.
SELECT extensions.dblink_exec(
  'rate_limit_a',
  $$DELETE FROM public.projects
    WHERE id = '55555555-5555-5555-5555-555555555135'$$
);
SELECT extensions.dblink_exec(
  'rate_limit_a',
  $$DELETE FROM auth.users
    WHERE id = '66666666-6666-6666-6666-666666666135'$$
);
SELECT extensions.dblink_disconnect('rate_limit_a');
SELECT extensions.dblink_disconnect('rate_limit_b');
