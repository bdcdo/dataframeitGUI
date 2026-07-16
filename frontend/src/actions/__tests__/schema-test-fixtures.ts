import type { PydanticField, SchemaBaselineIdentity } from "@/lib/types";
import type { TableResult } from "./supabase-mock";

export const FIELD: PydanticField = {
  name: "q1",
  type: "text",
  options: null,
  description: "Pergunta 1",
};

export const PROJECT_SELECT: TableResult = {
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

export const EMPTY_BASELINE: SchemaBaselineIdentity = {
  version: "0.1.0",
  revision: 0,
};
