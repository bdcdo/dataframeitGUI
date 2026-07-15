import { parsePydanticFields } from "@/lib/pydantic-field";
import type { PydanticField } from "@/lib/types";

export const SCHEMA_DRAFT_FORMAT_VERSION = 2;

export interface SchemaDraftToken {
  draftId: string;
  revision: number;
}

export interface SchemaDraftEnvelope extends SchemaDraftToken {
  formatVersion: typeof SCHEMA_DRAFT_FORMAT_VERSION;
  updatedAt: number;
  baseVersion: string;
  baseFingerprint: string;
  fields: PydanticField[];
}

const envelopeKeys = new Set([
  "formatVersion",
  "draftId",
  "revision",
  "updatedAt",
  "baseVersion",
  "baseFingerprint",
  "fields",
]);
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

export function parseSchemaDraft(raw: string | null): SchemaDraftEnvelope | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value) ||
      !hasOnlyKeys(value, envelopeKeys) ||
      value.formatVersion !== SCHEMA_DRAFT_FORMAT_VERSION ||
      typeof value.draftId !== "string" ||
      value.draftId.length === 0 ||
      !Number.isSafeInteger(value.revision) ||
      Number(value.revision) < 1 ||
      !Number.isFinite(value.updatedAt) ||
      Number(value.updatedAt) <= 0 ||
      typeof value.baseVersion !== "string" ||
      typeof value.baseFingerprint !== "string" ||
      !Array.isArray(value.fields)
    ) {
      return null;
    }
    // O editor permite estados intermediários ainda não salváveis (descrição
    // vazia, opção em construção etc.). Aqui validamos apenas o contrato
    // estrutural; `validateGUIFields` continua bloqueando o save.
    const parsedFields = parsePydanticFields(value.fields);
    if (!parsedFields) return null;
    return {
      formatVersion: SCHEMA_DRAFT_FORMAT_VERSION,
      draftId: value.draftId,
      revision: Number(value.revision),
      updatedAt: Number(value.updatedAt),
      baseVersion: value.baseVersion,
      baseFingerprint: value.baseFingerprint,
      fields: parsedFields,
    };
  } catch {
    return null;
  }
}

export function schemaDraftToken(draft: SchemaDraftEnvelope): SchemaDraftToken {
  return { draftId: draft.draftId, revision: draft.revision };
}

export function schemaDraftTokenMatches(
  draft: SchemaDraftEnvelope,
  token: SchemaDraftToken,
): boolean {
  return draft.draftId === token.draftId && draft.revision === token.revision;
}
