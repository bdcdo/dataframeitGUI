import { z } from "zod";
import { pydanticFieldsSchema } from "@/lib/pydantic-field";

export const SCHEMA_DRAFT_FORMAT_VERSION = 3;

const schemaSnapshotSchema = z.strictObject({
  fields: pydanticFieldsSchema,
  version: z.string(),
  revision: z.number().int().nonnegative(),
});

const schemaDraftEnvelopeSchema = z.strictObject({
  formatVersion: z.literal(SCHEMA_DRAFT_FORMAT_VERSION),
  writeToken: z.string().min(1),
  updatedAt: z.number().positive().finite(),
  base: schemaSnapshotSchema,
  fields: pydanticFieldsSchema,
});

export type SchemaDraftEnvelope = z.infer<typeof schemaDraftEnvelopeSchema>;

export function parseSchemaDraft(raw: string | null): SchemaDraftEnvelope | null {
  if (!raw) return null;
  try {
    const result = schemaDraftEnvelopeSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function schemaDraftTokenMatches(
  draft: SchemaDraftEnvelope,
  writeToken: string,
): boolean {
  return draft.writeToken === writeToken;
}
