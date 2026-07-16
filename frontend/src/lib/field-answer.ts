import { isIncompleteOther } from "@/lib/other-option";
import { resolveRequired } from "@/lib/pydantic-field";
import type { PydanticField } from "@/lib/types";

export const NOT_INFORMED = "Não informada";

export interface FieldAnswerAssessment {
  state: "empty" | "valid" | "invalid";
  missingSubfields: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function answeredCompositeKeys(
  field: PydanticField,
  value: unknown,
): Set<string> {
  const record = isRecord(value) ? value : {};
  return new Set(
    (field.subfields ?? [])
      .filter((subfield) => {
        const subfieldValue = record[subfield.key];
        return typeof subfieldValue === "string" && subfieldValue.trim() !== "";
      })
      .map((subfield) => subfield.key),
  );
}

function contentAssessment(answeredKeys: Set<string>): FieldAnswerAssessment {
  return {
    state: answeredKeys.size > 0 ? "valid" : "empty",
    missingSubfields: [],
  };
}

function assessCompositeAnswer(
  field: PydanticField,
  value: unknown,
): FieldAnswerAssessment {
  if (value === NOT_INFORMED) return { state: "valid", missingSubfields: [] };

  const subfields = field.subfields ?? [];
  const answeredKeys = answeredCompositeKeys(field, value);

  if (
    !resolveRequired(field.required) ||
    field.subfield_rule === "at_least_one"
  ) {
    return contentAssessment(answeredKeys);
  }

  const requiredSubfields = subfields.filter(
    (subfield) => subfield.required === true,
  );
  if (requiredSubfields.length === 0) return contentAssessment(answeredKeys);

  const missingSubfields = requiredSubfields
    .filter((subfield) => !answeredKeys.has(subfield.key))
    .map((subfield) => subfield.key);
  return {
    state: missingSubfields.length === 0 ? "valid" : "invalid",
    missingSubfields,
  };
}

// Fonte única da semântica de resposta usada pela interface e pelos gates de
// persistência. Para campos compostos, somente strings não vazias de chaves
// declaradas contam como conteúdo; propriedades desconhecidas e valores
// malformados não conseguem satisfazer a regra do grupo.
export function assessFieldAnswer(
  field: PydanticField,
  value: unknown,
): FieldAnswerAssessment {
  if (field.type === "text" && field.subfields?.length) {
    return assessCompositeAnswer(field, value);
  }

  if (value === undefined || value === null || value === "") {
    return { state: "empty", missingSubfields: [] };
  }
  if (field.type === "single" && isIncompleteOther(value)) {
    return { state: "invalid", missingSubfields: [] };
  }
  if (field.type === "multi" && Array.isArray(value)) {
    if (value.length === 0) return { state: "empty", missingSubfields: [] };
    if (value.some(isIncompleteOther)) {
      return { state: "invalid", missingSubfields: [] };
    }
  }
  return { state: "valid", missingSubfields: [] };
}

export function normalizeCompositeAnswers(
  fields: PydanticField[],
  answers: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = { ...answers };

  for (const field of fields) {
    if (field.type !== "text" || !field.subfields?.length) continue;

    const value = normalized[field.name];
    if (value === NOT_INFORMED) continue;
    if (!isRecord(value)) {
      delete normalized[field.name];
      continue;
    }

    const composite: Record<string, string> = {};
    for (const subfield of field.subfields) {
      const subfieldValue = value[subfield.key];
      if (typeof subfieldValue === "string") {
        composite[subfield.key] = subfieldValue;
      }
    }
    normalized[field.name] = composite;
  }

  return normalized;
}
