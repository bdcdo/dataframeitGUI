import { z } from "zod";
import {
  editablePydanticFieldsSchema,
  generateFieldId,
  pydanticFieldSchema,
  pydanticFieldsSchema,
  type PydanticField,
} from "@/lib/pydantic-field";

// v5: campos carregam `id` (#473). A base é estado persistido (ids e nomes
// únicos); o rascunho é estado editável (ids únicos, nomes podem duplicar
// transitoriamente — a duplicata só é barrada no save).
export const SCHEMA_DRAFT_FORMAT_VERSION = 5;

const schemaSnapshotSchema = z.strictObject({
  fields: pydanticFieldsSchema,
  version: z.string(),
  revision: z.number().int().nonnegative(),
});

const schemaDraftEnvelopeSchema = z.strictObject({
  formatVersion: z.literal(SCHEMA_DRAFT_FORMAT_VERSION),
  writeToken: z.string().min(1),
  base: schemaSnapshotSchema,
  fields: editablePydanticFieldsSchema,
});

export type SchemaDraftEnvelope = z.infer<typeof schemaDraftEnvelopeSchema>;

// ---------- Formato anterior (v4): campos sem `id` ----------
// Derivado por `.omit()` do shape canônico em vez de redeclarado: o v4 é
// exatamente o contrato atual menos a identidade, e uma cópia divergiria em
// silêncio quando o shape mudasse de novo.
const pydanticFieldV4Schema = pydanticFieldSchema.omit({ id: true });

const pydanticFieldsV4Schema = z
  .array(pydanticFieldV4Schema)
  .superRefine((fields, context) => {
    const names = new Set<string>();
    for (let index = 0; index < fields.length; index += 1) {
      const name = fields[index].name;
      if (names.has(name)) {
        context.addIssue({
          code: "custom",
          path: [index, "name"],
          message: `Campo ${index + 1}: nome "${name}" duplicado`,
        });
      }
      names.add(name);
    }
  });

const schemaSnapshotV4Schema = z.strictObject({
  fields: pydanticFieldsV4Schema,
  version: z.string(),
  revision: z.number().int().nonnegative(),
});

const schemaDraftEnvelopeV4Schema = z.strictObject({
  formatVersion: z.literal(4),
  writeToken: z.string().min(1),
  base: schemaSnapshotV4Schema,
  fields: pydanticFieldsV4Schema,
});

export type SchemaDraftEnvelopeV4 = z.infer<typeof schemaDraftEnvelopeV4Schema>;

// Só o marcador de formato, sem `strictObject`: serve para reconhecer um
// envelope que existe mas que este build não sabe ler.
const formatMarkerSchema = z.object({ formatVersion: z.number().int() });

// Devolver apenas `null` obrigava o compare-and-swap a tratar "não sei ler" e
// "não tem nada" como a mesma coisa. Num deploy que bumpe o formato — já
// aconteceu 4 vezes — a aba velha leria o envelope novo, concluiria "slot
// livre" e sobrescreveria em silêncio o rascunho da aba nova. Um envelope de
// formato MAIOR que o nosso foi escrito por um build que sabe mais: não é lixo,
// é de outro dono.
export type SchemaDraftRead =
  // Vazio ou lixo que nem envelope é: nada foi perdido ao assumir o slot.
  | { kind: "empty" }
  | { kind: "draft"; draft: SchemaDraftEnvelope }
  // Envelope v4 legível: diferente dos bumps anteriores, o v4 não é descartado
  // — `convertSchemaDraftV4` reconstrói a identidade dos campos a partir do
  // snapshot remoto e o rascunho sobrevive ao deploy.
  | { kind: "convertible"; draft: SchemaDraftEnvelopeV4 }
  // Envelope que este build não sabe ler, mas de um formato que ele já superou
  // (ou do formato corrente, corrompido). O slot é assumível — não há como
  // mesclar o conteúdo com o contrato atual —, mas existia trabalho ali e o
  // usuário precisa saber. Separado de `empty` porque "não havia rascunho" e
  // "havia um rascunho que não consegui ler" são fatos diferentes, e colapsá-los
  // era a via mais provável de perda silenciosa: o formato já foi bumpado 4
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

  const envelopeV4 = schemaDraftEnvelopeV4Schema.safeParse(parsed);
  if (envelopeV4.success) return { kind: "convertible", draft: envelopeV4.data };

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

// Converte um envelope v4 (campos sem id) para v5, reconstruindo a identidade:
// a base do rascunho casa por NOME com o snapshot remoto (que já vem do banco
// com ids pós-backfill) e reusa o id remoto; os campos do rascunho casam por
// nome com a base já convertida. Nome que não existe do outro lado ganha UUID
// novo — para o merge isso é um add/delete legítimo, que é exatamente o que um
// campo criado ou removido durante a janela do deploy significa. `writeToken`
// é preservado: o slot continua sendo da mesma aba.
export function convertSchemaDraftV4(
  draft: SchemaDraftEnvelopeV4,
  remoteFields: PydanticField[],
): SchemaDraftEnvelope {
  const remoteIdByName = new Map(
    remoteFields.map((field) => [field.name, field.id]),
  );
  const baseFields = draft.base.fields.map((field) => ({
    ...field,
    id: remoteIdByName.get(field.name) ?? generateFieldId(),
  }));
  const baseIdByName = new Map(
    baseFields.map((field) => [field.name, field.id]),
  );
  const draftFields = draft.fields.map((field) => ({
    ...field,
    id: baseIdByName.get(field.name) ?? generateFieldId(),
  }));
  return {
    formatVersion: SCHEMA_DRAFT_FORMAT_VERSION,
    writeToken: draft.writeToken,
    base: { ...draft.base, fields: baseFields },
    fields: draftFields,
  };
}

export function parseSchemaDraft(raw: string | null): SchemaDraftEnvelope | null {
  const read = readSchemaDraft(raw);
  return read.kind === "draft" ? read.draft : null;
}
