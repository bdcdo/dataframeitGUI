-- Ordem custom de perguntas por pesquisador, por projeto.
-- Quando ausente, o app cai na ordem canonica de projects.pydantic_fields (fallback).
-- field_order e array de PydanticField.name; campos nao-listados (renomeados/removidos)
-- sao tratados no client via lib/field-order.ts (applyFieldOrder): nomes desconhecidos
-- sao descartados, nomes novos vao para o fim.

CREATE TABLE researcher_field_orders (
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  field_order  JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

-- PK (project_id, user_id) ja cobre o unico padrao de acesso ("para este projeto, qual a
-- minha ordem"). Sem indice adicional.

ALTER TABLE researcher_field_orders ENABLE ROW LEVEL SECURITY;

-- SELECT: usuario so le sua propria linha e desde que tenha acesso ao projeto.
CREATE POLICY "Users view own field order" ON researcher_field_orders
  FOR SELECT USING (
    user_id = clerk_uid()
    AND project_id IN (SELECT auth_user_accessible_project_ids())
  );

-- INSERT/UPSERT: idem.
CREATE POLICY "Users insert own field order" ON researcher_field_orders
  FOR INSERT WITH CHECK (
    user_id = clerk_uid()
    AND project_id IN (SELECT auth_user_accessible_project_ids())
  );

CREATE POLICY "Users update own field order" ON researcher_field_orders
  FOR UPDATE USING (user_id = clerk_uid())
  WITH CHECK (user_id = clerk_uid());

CREATE POLICY "Users delete own field order" ON researcher_field_orders
  FOR DELETE USING (user_id = clerk_uid());
