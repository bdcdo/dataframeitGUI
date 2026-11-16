import type { PydanticField, SchemaBaselineIdentity } from "@/lib/types";

export const FIELD: PydanticField = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "q1",
  type: "text",
  options: null,
  description: "Pergunta 1",
};

export const PROJECT_SELECT = {
  data: {
    pydantic_fields: [],
    pydantic_code: null,
    pydantic_hash: null,
    schema_version_major: 0,
    schema_version_minor: 1,
    schema_version_patch: 0,
    schema_revision: 0,
  },
};

// O projeto como linha da tabela, para o mock filter-aware: as colunas de
// PROJECT_SELECT mais o `id` que a leitura filtra. Fábrica, para nenhum teste
// compartilhar o array de campos.
export const projectRow = (extra: Record<string, unknown> = {}) => ({
  ...(PROJECT_SELECT.data as object),
  id: "p1",
  pydantic_fields: [] as PydanticField[],
  ...extra,
});

export const EMPTY_BASELINE: SchemaBaselineIdentity = {
  revision: 0,
};
