import { z } from "zod";
import {
  editablePydanticFieldsSchema,
  generateFieldId,
  pydanticFieldSchema,
  pydanticFieldsSchema,
  refineUniqueNames,
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

// Sem `id`, nome ainda é a identidade — que é justamente a semântica que a
// conversão precisa honrar. O refinamento é o MESMO de `pydanticFieldsSchema`,
// importado em vez de copiado.
const pydanticFieldsV4Schema = z
  .array(pydanticFieldV4Schema)
  .superRefine(refineUniqueNames);

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

// Converte um envelope v4 (campos sem id) para v5, reconstruindo a identidade.
//
// O casamento é por NOME porque é essa a semântica sob a qual o envelope v4 foi
// escrito: antes da #473, nome ERA a identidade. Honrá-la na conversão é o que
// faz o rascunho atravessar o deploy significando a mesma coisa que significava
// quando foi gravado. A baseline casa contra o snapshot remoto (que já vem do
// banco com os ids do backfill); os campos do rascunho casam contra a baseline
// já convertida e, se o nome não estiver lá, contra o remoto — senão um campo
// adicionado dos dois lados durante a janela do deploy viraria DOIS campos de
// mesmo nome, e o save ficaria bloqueado por uma duplicata que o usuário não
// criou. Nome que não existe em nenhum dos dois é adição local de verdade e
// ganha UUID novo. `writeToken` é preservado: o slot continua sendo da mesma aba.
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
    id:
      baseIdByName.get(field.name) ??
      remoteIdByName.get(field.name) ??
      generateFieldId(),
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
