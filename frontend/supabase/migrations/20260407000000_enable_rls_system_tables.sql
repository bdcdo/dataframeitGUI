-- Enable RLS on system tables to satisfy Supabase security advisor.
-- These tables are not meant to be accessed via PostgREST by end users.

-- 1. master_users: already has REVOKE ALL, add RLS as defense-in-depth
ALTER TABLE master_users ENABLE ROW LEVEL SECURITY;

-- 2. clerk_user_mapping: add REVOKE + RLS
REVOKE ALL ON clerk_user_mapping FROM anon, authenticated;
ALTER TABLE clerk_user_mapping ENABLE ROW LEVEL SECURITY;
