-- field_reviews: auto-revisao humano vs LLM + arbitragem em duas fases.
--
-- Fluxo:
--  1) humano original codifica e submete (responses humana criada)
--  2) sistema detecta diverg. com a resposta LLM e cria 1 row por campo divergente:
--     self_reviewer_id=humano, self_verdict=NULL (pendente).
--  3) auto-revisao: humano define self_verdict='admite_erro' OU 'contesta_llm'.
--     - admite_erro: gabarito final = LLM (campo fica resolvido)
--     - contesta_llm: arbitrator_id e populado por sorteio
--  4) arbitragem em 2 fases:
--     - blind_verdict (cego, sem justificativa LLM)
--     - final_verdict (apos ver justificativa LLM; pode trocar)
--     - se final_verdict='llm' (humano perdeu), exigir question_improvement_suggestion
--
-- UNIQUE (document_id, field_name) garante 1 linha por (doc, campo) — idempotente.

CREATE TABLE field_reviews (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id                     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  field_name                      TEXT NOT NULL,

  human_response_id               UUID NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  llm_response_id                 UUID NOT NULL REFERENCES responses(id) ON DELETE CASCADE,

  self_reviewer_id                UUID NOT NULL REFERENCES profiles(id),
  self_verdict                    TEXT CHECK (self_verdict IN ('admite_erro', 'contesta_llm')),
  self_reviewed_at                TIMESTAMPTZ,

  arbitrator_id                   UUID REFERENCES profiles(id),
  blind_verdict                   TEXT CHECK (blind_verdict IN ('humano', 'llm')),
  blind_decided_at                TIMESTAMPTZ,
  final_verdict                   TEXT CHECK (final_verdict IN ('humano', 'llm')),
  final_decided_at                TIMESTAMPTZ,
  changed_after_justification     BOOLEAN GENERATED ALWAYS AS (
    blind_verdict IS NOT NULL
    AND final_verdict IS NOT NULL
    AND blind_verdict <> final_verdict
  ) STORED,
  question_improvement_suggestion TEXT,
  arbitrator_comment              TEXT,

  created_at                      TIMESTAMPTZ DEFAULT now(),

  CONSTRAINT field_reviews_unique UNIQUE (document_id, field_name)
);

CREATE INDEX idx_field_reviews_project ON field_reviews(project_id);
CREATE INDEX idx_field_reviews_self_reviewer ON field_reviews(self_reviewer_id) WHERE self_verdict IS NULL;
CREATE INDEX idx_field_reviews_pending_arbitration ON field_reviews(arbitrator_id)
  WHERE self_verdict = 'contesta_llm' AND final_verdict IS NULL;

ALTER TABLE field_reviews ENABLE ROW LEVEL SECURITY;

-- Membros do projeto leem
CREATE POLICY "Members view field_reviews" ON field_reviews FOR SELECT USING (
  project_id IN (SELECT auth_user_accessible_project_ids())
  OR is_master()
);

-- Coordenadores/criadores podem tudo (incluindo INSERT inicial via server action
-- que usa supabase_server autenticado pelo Clerk JWT)
CREATE POLICY "Coordinators manage field_reviews" ON field_reviews FOR ALL USING (
  project_id IN (SELECT auth_user_coordinator_or_creator_project_ids())
  OR is_master()
);

-- Humano original atualiza/insere a sua fase (self_*)
CREATE POLICY "Self reviewer manages own row" ON field_reviews FOR ALL USING (
  self_reviewer_id = clerk_uid()
);

-- Arbitro atualiza a sua fase (blind/final)
CREATE POLICY "Arbitrator manages own row" ON field_reviews FOR ALL USING (
  arbitrator_id = clerk_uid()
);
