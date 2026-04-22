-- Allow coordinators to mark verdict acknowledgment questions as "seen/resolved"
-- without changing the respondent's status (which only the respondent can change
-- via "Meu Gabarito" acknowledging the verdict).
ALTER TABLE verdict_acknowledgments
  ADD COLUMN resolved_at TIMESTAMPTZ,
  ADD COLUMN resolved_by UUID REFERENCES profiles(id);

CREATE INDEX idx_verdict_ack_unresolved
  ON verdict_acknowledgments(review_id)
  WHERE resolved_at IS NULL;

-- Coordinators of the project can update any row (to toggle resolved fields)
CREATE POLICY "Coordinators can update verdict_acknowledgments" ON verdict_acknowledgments
  FOR UPDATE USING (
    review_id IN (
      SELECT id FROM reviews
      WHERE project_id IN (SELECT auth_user_coordinator_project_ids())
         OR project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
    )
  );
