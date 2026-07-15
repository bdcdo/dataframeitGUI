-- Distributed fixed-window rate limit for paid LLM dispatches (#135).
--
-- The FastAPI service calls only the RPC below with its service-role key. The
-- table has one row per project-scoped effective member identity, so machine
-- restarts and horizontal scaling cannot create independent counters.

CREATE TABLE public.llm_rate_limit_buckets (
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count BETWEEN 1 AND 10000),
  PRIMARY KEY (project_id, user_id)
);

-- project_id is the leading primary-key column; this complementary index keeps
-- profile deletion from scanning every project bucket for the user FK cascade.
CREATE INDEX llm_rate_limit_buckets_user_id_idx
  ON public.llm_rate_limit_buckets (user_id);

ALTER TABLE public.llm_rate_limit_buckets ENABLE ROW LEVEL SECURITY;

-- No direct client or backend table access: all mutation is serialized by the
-- SECURITY DEFINER RPC. The service role gets EXECUTE on that function only.
REVOKE ALL ON TABLE public.llm_rate_limit_buckets
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.consume_llm_rate_limit(
  p_user_id uuid,
  p_project_id uuid,
  p_limit integer,
  p_window_seconds integer
) RETURNS TABLE (allowed boolean, retry_after_seconds integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_effective_user_id uuid;
  v_effective_identity_count integer;
  v_now timestamptz := clock_timestamp();
  v_window_started_at timestamptz;
  v_request_count integer;
  v_created boolean := false;
BEGIN
  IF p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 10000';
  END IF;
  IF p_window_seconds < 1 OR p_window_seconds > 86400 THEN
    RAISE EXCEPTION 'p_window_seconds must be between 1 and 86400';
  END IF;

  -- More than one canonical identity for the same linked account would make
  -- the budget key ambiguous. Reject that malformed state instead of choosing
  -- one silently; repeated links to the same canonical identity are harmless.
  SELECT COUNT(DISTINCT links.member_user_id),
         MIN(links.member_user_id::text)::uuid
  INTO v_effective_identity_count, v_effective_user_id
  FROM public.member_email_links AS links
  WHERE links.project_id = p_project_id
    AND links.linked_user_id = p_user_id;
  IF v_effective_identity_count > 1 THEN
    RAISE EXCEPTION
      'linked user maps to multiple effective identities in this project';
  END IF;
  v_effective_user_id := COALESCE(v_effective_user_id, p_user_id);

  -- Concurrent first requests race on the primary key. The loser waits for the
  -- winner's insert, then falls through to the same row lock used below.
  INSERT INTO public.llm_rate_limit_buckets (
    project_id, user_id, window_started_at, request_count
  ) VALUES (
    p_project_id, v_effective_user_id, v_now, 1
  )
  ON CONFLICT (project_id, user_id) DO NOTHING
  RETURNING true INTO v_created;

  IF v_created THEN
    RETURN QUERY SELECT true, p_window_seconds;
    RETURN;
  END IF;

  SELECT buckets.window_started_at, buckets.request_count
  INTO v_window_started_at, v_request_count
  FROM public.llm_rate_limit_buckets AS buckets
  WHERE buckets.project_id = p_project_id
    AND buckets.user_id = v_effective_user_id
  FOR UPDATE;

  -- A conflicting request may have waited on the row lock. Refresh the clock
  -- after that wait so reset and Retry-After use the actual decision time.
  v_now := clock_timestamp();

  IF v_window_started_at + make_interval(secs => p_window_seconds) <= v_now THEN
    UPDATE public.llm_rate_limit_buckets AS buckets
    SET window_started_at = v_now,
        request_count = 1
    WHERE buckets.project_id = p_project_id
      AND buckets.user_id = v_effective_user_id;
    RETURN QUERY SELECT true, p_window_seconds;
    RETURN;
  END IF;

  IF v_request_count < p_limit THEN
    UPDATE public.llm_rate_limit_buckets AS buckets
    SET request_count = buckets.request_count + 1
    WHERE buckets.project_id = p_project_id
      AND buckets.user_id = v_effective_user_id;
    RETURN QUERY SELECT true,
      GREATEST(
        1,
        CEIL(EXTRACT(EPOCH FROM (
          v_window_started_at
          + make_interval(secs => p_window_seconds)
          - v_now
        )))::integer
      );
    RETURN;
  END IF;

  RETURN QUERY SELECT false,
    GREATEST(
      1,
      CEIL(EXTRACT(EPOCH FROM (
        v_window_started_at
        + make_interval(secs => p_window_seconds)
        - v_now
      )))::integer
    );
END;
$$;

REVOKE ALL ON FUNCTION public.consume_llm_rate_limit(uuid, uuid, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.consume_llm_rate_limit(uuid, uuid, integer, integer)
  TO service_role;
