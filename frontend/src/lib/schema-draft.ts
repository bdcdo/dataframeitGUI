import { z } from "zod";
import { pydanticFieldsSchema } from "@/lib/pydantic-field";

export const SCHEMA_DRAFT_FORMAT_VERSION = 4;

const schemaSnapshotSchema = z.strictObject({
  fields: pydanticFieldsSchema,
  version: z.string(),
  revision: z.number().int().nonnegative(),
});

const schemaDraftEnvelopeSchema = z.strictObject({
  formatVersion: z.literal(SCHEMA_DRAFT_FORMAT_VERSION),
  writeToken: z.string().min(1),
  base: schemaSnapshotSchema,
  fields: pydanticFieldsSchema,
});

export type SchemaDraftEnvelope = z.infer<typeof schemaDraftEnvelopeSchema>;

// Só o marcador de formato, sem `strictObject`: serve para reconhecer um
// envelope que existe mas que este build não sabe ler.
const formatMarkerSchema = z.object({ formatVersion: z.number().int() });

// Devolver apenas `null` obrigava o compare-and-swap a tratar "não sei ler" e
// "não tem nada" como a mesma coisa. Num deploy que bumpe o formato — já
// aconteceu 3 vezes — a aba velha leria o envelope novo, concluiria "slot
// livre" e sobrescreveria em silêncio o rascunho da aba nova. Um envelope de
// formato MAIOR que o nosso foi escrito por um build que sabe mais: não é lixo,
// é de outro dono.
export type SchemaDraftRead =
  // Vazio, lixo, ou formato anterior ao nosso: o slot é assumível.
  | { kind: "empty" }
  | { kind: "draft"; draft: SchemaDraftEnvelope }
  | { kind: "newer-format"; formatVersion: number };

export function readSchemaDraft(raw: string | null): SchemaDraftRead {
  if (!raw) return { kind: "empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "empty" };
  }

  const envelope = schemaDraftEnvelopeSchema.safeParse(parsed);
  if (envelope.success) return { kind: "draft", draft: envelope.data };

  const marker = formatMarkerSchema.safeParse(parsed);
  if (marker.success && marker.data.formatVersion > SCHEMA_DRAFT_FORMAT_VERSION) {
    return { kind: "newer-format", formatVersion: marker.data.formatVersion };
  }

  // Formato anterior ao nosso conta como assumível de propósito: não há como
  // mesclá-lo com o contrato atual, e travar o rascunho para sempre por causa
  // de um envelope que ninguém mais escreve seria pior do que assumir o slot.
  return { kind: "empty" };
}

export function parseSchemaDraft(raw: string | null): SchemaDraftEnvelope | null {
  const read = readSchemaDraft(raw);
  return read.kind === "draft" ? read.draft : null;
}
