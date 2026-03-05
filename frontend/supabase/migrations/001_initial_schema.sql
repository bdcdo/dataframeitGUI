-- profiles
CREATE TABLE profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  first_name  TEXT,
  last_name   TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own profile" ON profiles FOR ALL USING (auth.uid() = id);

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- projects
CREATE TABLE projects (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  description     TEXT,
  created_by      UUID REFERENCES profiles(id),
  created_at      TIMESTAMPTZ DEFAULT now(),
  pydantic_code   TEXT,
  pydantic_hash   TEXT,
  pydantic_fields JSONB,
  prompt_template TEXT,
  llm_provider    TEXT DEFAULT 'google_genai',
  llm_model       TEXT DEFAULT 'gemini-3-flash-preview',
  llm_kwargs      JSONB DEFAULT '{"temperature": 1.0, "thinking_level": "medium"}',
  resolution_rule              TEXT DEFAULT 'majority',
  min_responses_for_comparison INTEGER DEFAULT 2,
  allow_researcher_review      BOOLEAN DEFAULT false
);

-- project_members
CREATE TABLE project_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID REFERENCES projects(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES profiles(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('coordenador', 'pesquisador')),
  UNIQUE(project_id, user_id)
);

ALTER TABLE project_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members view members" ON project_members FOR SELECT USING (
  project_id IN (SELECT project_id FROM project_members WHERE user_id = auth.uid())
);
CREATE POLICY "Coordinators manage members" ON project_members FOR ALL USING (
  project_id IN (
    SELECT project_id FROM project_members WHERE user_id = auth.uid() AND role = 'coordenador'
  )
);
CREATE POLICY "Creator inserts members" ON project_members FOR INSERT WITH CHECK (
  project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
);

-- projects RLS (após project_members existir)
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members view projects" ON projects FOR SELECT USING (
  id IN (SELECT project_id FROM project_members WHERE user_id = auth.uid())
  OR created_by = auth.uid()
);
CREATE POLICY "Creator manages projects" ON projects FOR ALL USING (created_by = auth.uid());

-- documents
CREATE TABLE documents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID REFERENCES projects(id) ON DELETE CASCADE,
  external_id TEXT,
  title       TEXT,
  text        TEXT NOT NULL,
  metadata    JSONB,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_documents_project ON documents(project_id);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members view documents" ON documents FOR SELECT USING (
  project_id IN (SELECT project_id FROM project_members WHERE user_id = auth.uid())
  OR project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
);
CREATE POLICY "Coordinators manage documents" ON documents FOR ALL USING (
  project_id IN (
    SELECT project_id FROM project_members WHERE user_id = auth.uid() AND role = 'coordenador'
  )
  OR project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
);

-- assignments
CREATE TABLE assignments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID REFERENCES projects(id) ON DELETE CASCADE,
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES profiles(id) ON DELETE CASCADE,
  status      TEXT DEFAULT 'pendente' CHECK (status IN ('pendente', 'em_andamento', 'concluido')),
  UNIQUE(document_id, user_id)
);
CREATE INDEX idx_assignments_user ON assignments(project_id, user_id);

ALTER TABLE assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members view assignments" ON assignments FOR SELECT USING (
  project_id IN (SELECT project_id FROM project_members WHERE user_id = auth.uid())
  OR project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
);
CREATE POLICY "Coordinators manage assignments" ON assignments FOR ALL USING (
  project_id IN (
    SELECT project_id FROM project_members WHERE user_id = auth.uid() AND role = 'coordenador'
  )
  OR project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
);

-- responses
CREATE TABLE responses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID REFERENCES projects(id) ON DELETE CASCADE,
  document_id     UUID REFERENCES documents(id) ON DELETE CASCADE,
  respondent_id   UUID REFERENCES profiles(id),
  respondent_type TEXT NOT NULL CHECK (respondent_type IN ('humano', 'llm')),
  respondent_name TEXT,
  answers         JSONB NOT NULL,
  justifications  JSONB,
  is_current      BOOLEAN DEFAULT true,
  pydantic_hash   TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_responses_document ON responses(project_id, document_id);
CREATE INDEX idx_responses_type ON responses(project_id, respondent_type);

ALTER TABLE responses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members view responses" ON responses FOR SELECT USING (
  project_id IN (SELECT project_id FROM project_members WHERE user_id = auth.uid())
  OR project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
);
CREATE POLICY "Users manage own responses" ON responses FOR ALL USING (
  respondent_id = auth.uid()
  OR project_id IN (
    SELECT project_id FROM project_members WHERE user_id = auth.uid() AND role = 'coordenador'
  )
  OR project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
);

-- reviews
CREATE TABLE reviews (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         UUID REFERENCES projects(id) ON DELETE CASCADE,
  document_id        UUID REFERENCES documents(id) ON DELETE CASCADE,
  field_name         TEXT NOT NULL,
  reviewer_id        UUID REFERENCES profiles(id),
  verdict            TEXT NOT NULL,
  chosen_response_id UUID REFERENCES responses(id),
  comment            TEXT,
  created_at         TIMESTAMPTZ DEFAULT now(),
  UNIQUE(project_id, document_id, field_name, reviewer_id)
);
CREATE INDEX idx_reviews_document ON reviews(project_id, document_id);

ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members view reviews" ON reviews FOR SELECT USING (
  project_id IN (SELECT project_id FROM project_members WHERE user_id = auth.uid())
  OR project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
);
CREATE POLICY "Reviewers manage reviews" ON reviews FOR ALL USING (
  reviewer_id = auth.uid()
  OR project_id IN (
    SELECT project_id FROM project_members WHERE user_id = auth.uid() AND role = 'coordenador'
  )
  OR project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
);

-- question_meta
CREATE TABLE question_meta (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID REFERENCES projects(id) ON DELETE CASCADE,
  field_name  TEXT NOT NULL,
  priority    TEXT DEFAULT 'MEDIA' CHECK (priority IN ('ALTA', 'MEDIA', 'BAIXA')),
  UNIQUE(project_id, field_name)
);

ALTER TABLE question_meta ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members view question_meta" ON question_meta FOR SELECT USING (
  project_id IN (SELECT project_id FROM project_members WHERE user_id = auth.uid())
  OR project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
);
CREATE POLICY "Coordinators manage question_meta" ON question_meta FOR ALL USING (
  project_id IN (
    SELECT project_id FROM project_members WHERE user_id = auth.uid() AND role = 'coordenador'
  )
  OR project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
);
