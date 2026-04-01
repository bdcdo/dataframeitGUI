-- Remove discussion_id FK from resolution tables
ALTER TABLE difficulty_resolutions DROP COLUMN IF EXISTS discussion_id;
ALTER TABLE error_resolutions DROP COLUMN IF EXISTS discussion_id;

-- Drop discussion tables
DROP TABLE IF EXISTS discussion_comments;
DROP TABLE IF EXISTS discussions;
