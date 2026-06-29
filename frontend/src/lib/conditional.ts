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

function evaluateCondition(
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

// Zera as respostas de campos condicionais que não estão mais visíveis. Aplica
// ponto-fixo: limpar uma condicional pode esconder outra que dependia dela. Não
// muta a entrada — clona apenas na primeira mudança real (copy-on-write) e
// retorna o MESMO objeto quando nada muda, preservando a identidade referencial
// que o React usa para evitar re-renders.
export function clearHiddenConditionalAnswers(
  fields: PydanticField[],
  answers: Record<string, unknown>,
): Record<string, unknown> {
  let next = answers;
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of fields) {
      if (!f.condition) continue;
      if (isFieldVisible(f, next)) continue;
      const v = next[f.name];
      if (v !== undefined && v !== null && v !== "") {
        if (next === answers) next = { ...answers };
        next[f.name] = null;
        changed = true;
      }
    }
  }
  return next;
}

// Campos que podem servir de gatilho para a condição de `currentFieldName`:
// apenas campos anteriores (a condição só pode referenciar campos já definidos)
// e com opções (single/multi). Usado pelos editores de schema.
export function candidateTriggersFor(
  fields: PydanticField[],
  currentFieldName: string,
): PydanticField[] {
  const out: PydanticField[] = [];
  for (const f of fields) {
    if (f.name === currentFieldName) break;
    // Only fields with options can be meaningfully used as triggers
    // (single/multi). For text/date, a user can still target via `exists`,
    // but for the initial UX we restrict triggers to option-bearing fields.
    if ((f.type === "single" || f.type === "multi") && f.options && f.options.length > 0) {
      out.push(f);
    }
  }
  return out;
}
