import { schemaBaselineIdentity } from "@/lib/schema-utils";
import type { PydanticField } from "@/lib/types";
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
  },
};

export const EMPTY_BASELINE = schemaBaselineIdentity([], "0.1.0");
