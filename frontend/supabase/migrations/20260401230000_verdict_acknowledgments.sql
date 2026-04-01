-- Acknowledgments dos pesquisadores sobre vereditos
CREATE TABLE verdict_acknowledgments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  respondent_id UUID NOT NULL REFERENCES profiles(id),
  status TEXT NOT NULL DEFAULT 'pending',
  comment TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(review_id, respondent_id)
);

ALTER TABLE verdict_acknowledgments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view acknowledgments" ON verdict_acknowledgments
  FOR SELECT USING (
    review_id IN (
      SELECT id FROM reviews WHERE project_id IN (
        SELECT project_id FROM project_members WHERE user_id = clerk_uid()
      )
    )
  );

CREATE POLICY "Respondents can upsert own acknowledgments" ON verdict_acknowledgments
  FOR INSERT WITH CHECK (respondent_id = clerk_uid());

CREATE POLICY "Respondents can update own acknowledgments" ON verdict_acknowledgments
  FOR UPDATE USING (respondent_id = clerk_uid());
