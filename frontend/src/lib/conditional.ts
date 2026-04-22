import type {
  ConditionScalar,
  FieldCondition,
  PydanticField,
} from "@/lib/types";

function getNestedValue(
  data: Record<string, unknown>,
  path: string,
): unknown {
  if (!path) return undefined;
  const parts = path.split(".");
  let current: unknown = data;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
    if (current === undefined) return undefined;
  }
  return current;
}

function scalarEquals(a: unknown, b: ConditionScalar): boolean {
  if (typeof a === typeof b) return a === b;
  // Multi fields store string[]; caller handles that separately.
  return false;
}

function matchesScalar(value: unknown, target: ConditionScalar): boolean {
  if (Array.isArray(value)) {
    return value.some((v) => scalarEquals(v, target));
  }
  return scalarEquals(value, target);
}

export function evaluateCondition(
  condition: FieldCondition,
  answers: Record<string, unknown>,
): boolean {
  const value = getNestedValue(answers, condition.field);

  if ("equals" in condition) {
    return matchesScalar(value, condition.equals);
  }
  if ("not_equals" in condition) {
    if (value === undefined || value === null) return false;
    return !matchesScalar(value, condition.not_equals);
  }
  if ("in" in condition) {
    return condition.in.some((target) => matchesScalar(value, target));
  }
  if ("not_in" in condition) {
    if (value === undefined || value === null) return false;
    return !condition.not_in.some((target) => matchesScalar(value, target));
  }
  if ("exists" in condition) {
    const exists =
      value !== undefined &&
      value !== null &&
      !(typeof value === "string" && value === "") &&
      !(Array.isArray(value) && value.length === 0);
    return exists === condition.exists;
  }
  return false;
}

export function isFieldVisible(
  field: PydanticField,
  answers: Record<string, unknown>,
): boolean {
  if (!field.condition) return true;
  return evaluateCondition(field.condition, answers);
}

export function visibleFields(
  fields: PydanticField[],
  answers: Record<string, unknown>,
): PydanticField[] {
  return fields.filter((f) => isFieldVisible(f, answers));
}
