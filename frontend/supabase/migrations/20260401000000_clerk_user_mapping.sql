-- Mapping table to link Clerk user IDs to existing Supabase auth UUIDs.
-- This allows Clerk JWT integration without changing any RLS policies.

CREATE TABLE clerk_user_mapping (
  clerk_user_id  TEXT    PRIMARY KEY,
  supabase_user_id UUID  NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ DEFAULT now(),
  UNIQUE(supabase_user_id)
);

CREATE INDEX idx_clerk_mapping_supabase ON clerk_user_mapping(supabase_user_id);
