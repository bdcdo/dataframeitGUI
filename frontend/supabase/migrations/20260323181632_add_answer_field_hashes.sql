-- Track per-field schema hashes at the time each response was saved.
-- Enables field-level staleness detection without deleting data.
ALTER TABLE responses ADD COLUMN answer_field_hashes JSONB;
