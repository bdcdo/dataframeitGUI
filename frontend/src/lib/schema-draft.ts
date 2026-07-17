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
  // Vazio ou lixo que nem envelope é: nada foi perdido ao assumir o slot.
  | { kind: "empty" }
  | { kind: "draft"; draft: SchemaDraftEnvelope }
  // Envelope que este build não sabe ler, mas de um formato que ele já superou
  // (ou do formato corrente, corrompido). O slot é assumível — não há como
  // mesclar o conteúdo com o contrato atual —, mas existia trabalho ali e o
  // usuário precisa saber. Separado de `empty` porque "não havia rascunho" e
  // "havia um rascunho que não consegui ler" são fatos diferentes, e colapsá-los
  // era a via mais provável de perda silenciosa: o formato já foi bumpado 3
  // vezes, então todo deploy que bumpa produz este caso para quem tinha rascunho.
  | { kind: "stale-format"; formatVersion: number }
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
  if (marker.success) {
    if (marker.data.formatVersion > SCHEMA_DRAFT_FORMAT_VERSION) {
      return { kind: "newer-format", formatVersion: marker.data.formatVersion };
    }
    // Assumível de propósito: não há como mesclar um envelope antigo com o
    // contrato atual, e travar o slot para sempre por causa de um formato que
    // ninguém mais escreve seria pior. O que não se justifica é fazê-lo calado
    // — descartar e avisar é a terceira opção entre travar e apagar em silêncio.
    return { kind: "stale-format", formatVersion: marker.data.formatVersion };
  }

  return { kind: "empty" };
}

export function parseSchemaDraft(raw: string | null): SchemaDraftEnvelope | null {
  const read = readSchemaDraft(raw);
  return read.kind === "draft" ? read.draft : null;
}
