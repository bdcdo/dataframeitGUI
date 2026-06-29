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

// Núcleo compartilhado: nomes de campos condicionais que estão ocultos E têm
// valor não-vazio, calculados em ponto-fixo (limpar uma condicional pode
// esconder outra que dependia dela). Trabalha sobre uma view copy-on-write
// (clona só na primeira limpeza), marcando cada órfão como `null` para
// reavaliar a visibilidade em cascata — `null` e chave ausente são
// equivalentes para `isFieldVisible`, então o resultado independe de a fronteira
// querer zerar ou omitir. Cada campo é zerado no máximo uma vez (um valor já
// `null` falha o guard), o que garante terminação em ≤N passes. Não muta a
// entrada.
function hiddenConditionalNames(
  fields: PydanticField[],
  answers: Record<string, unknown>,
): Set<string> {
  const hidden = new Set<string>();
  let view = answers;
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of fields) {
      if (!f.condition) continue;
      if (hidden.has(f.name)) continue;
      if (isFieldVisible(f, view)) continue;
      const v = view[f.name];
      if (v !== undefined && v !== null && v !== "") {
        if (view === answers) view = { ...answers };
        view[f.name] = null;
        hidden.add(f.name);
        changed = true;
      }
    }
  }
  return hidden;
}

// Cliente (estado vivo de codificação): zera as respostas de condicionais
// ocultas para `null`. Retorna o MESMO objeto quando nada muda, preservando a
// identidade referencial que o React usa para evitar re-renders.
export function clearHiddenConditionalAnswers(
  fields: PydanticField[],
  answers: Record<string, unknown>,
): Record<string, unknown> {
  const hidden = hiddenConditionalNames(fields, answers);
  if (hidden.size === 0) return answers;
  const next = { ...answers };
  for (const name of hidden) next[name] = null;
  return next;
}

// Fronteira (leitura/escrita de respostas persistidas): OMITE as chaves de
// condicionais ocultas — mesma semântica de `delete` que o `saveResponse` usa.
// Centraliza a invariante "respostas não contêm valor de condicional oculta"
// numa primitiva só, aplicada tanto no clean de leitura quanto na sanitização
// de escrita (ver #252). Avaliar visibilidade sobre o conjunto COMPLETO de
// campos (não filtrado por `target`), pois uma condição pode referenciar
// qualquer campo. Retorna o MESMO objeto quando nada muda.
export function dropHiddenConditionals(
  fields: PydanticField[],
  answers: Record<string, unknown>,
): Record<string, unknown> {
  const hidden = hiddenConditionalNames(fields, answers);
  if (hidden.size === 0) return answers;
  const next = { ...answers };
  for (const name of hidden) delete next[name];
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
