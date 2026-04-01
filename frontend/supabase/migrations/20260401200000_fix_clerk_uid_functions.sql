-- Repair: recreate clerk_uid() and helper functions with explicit schema
-- and GRANT to PostgREST roles. Needed because the original migration
-- (20260401100000) was recorded but its function definitions did not
-- persist on the remote database.

-- 1. clerk_uid(): reads supabase_uid from Clerk JWT
CREATE OR REPLACE FUNCTION public.clerk_uid()
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT (auth.jwt()->>'supabase_uid')::uuid
$$;

-- 2. auth_user_project_ids(): projects the current user belongs to
CREATE OR REPLACE FUNCTION public.auth_user_project_ids()
RETURNS SETOF UUID
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY SELECT project_id FROM public.project_members WHERE user_id = public.clerk_uid();
END;
$$;

-- 3. auth_user_coordinator_project_ids(): projects where user is coordinator
CREATE OR REPLACE FUNCTION public.auth_user_coordinator_project_ids()
RETURNS SETOF UUID
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY SELECT project_id FROM public.project_members WHERE user_id = public.clerk_uid() AND role = 'coordenador';
END;
$$;

-- 4. Grant execute to PostgREST roles
GRANT EXECUTE ON FUNCTION public.clerk_uid() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.auth_user_project_ids() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.auth_user_coordinator_project_ids() TO anon, authenticated, service_role;
