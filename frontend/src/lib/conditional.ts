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

// Núcleo compartilhado do ponto-fixo: limpar uma condicional pode esconder
// outra que dependia dela, então iteramos até estabilizar. Trabalha sobre uma
// view copy-on-write (clona só na primeira limpeza), marcando cada órfão com
// valor SIGNIFICATIVO como `null` para reavaliar a visibilidade em cascata —
// `null` e chave ausente são equivalentes para `isFieldVisible`. O guard de
// valor não-vazio é essencial para a cascata: zerar um `""`/`null` não muda a
// visibilidade downstream (inclusive para `exists`), e limitar a limpeza a
// valores significativos garante terminação em ≤N passes (cada campo entra em
// `cleared` no máximo uma vez). Não muta a entrada. Retorna a `view` resolvida
// (com os órfãos significativos zerados) e o conjunto `cleared` de nomes que
// foram efetivamente zerados.
function resolveHiddenConditionals(
  fields: PydanticField[],
  answers: Record<string, unknown>,
): { view: Record<string, unknown>; cleared: Set<string> } {
  const cleared = new Set<string>();
  let view = answers;
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of fields) {
      if (!f.condition) continue;
      if (cleared.has(f.name)) continue;
      if (isFieldVisible(f, view)) continue;
      const v = view[f.name];
      if (v !== undefined && v !== null && v !== "") {
        if (view === answers) view = { ...answers };
        view[f.name] = null;
        cleared.add(f.name);
        changed = true;
      }
    }
  }
  return { view, cleared };
}

// Cliente (estado vivo de codificação): zera as respostas de condicionais
// ocultas para `null`. Só toca campos com valor significativo (o conjunto
// `cleared` do ponto-fixo), então retorna o MESMO objeto quando nada muda,
// preservando a identidade referencial que o React usa para evitar re-renders.
export function clearHiddenConditionalAnswers(
  fields: PydanticField[],
  answers: Record<string, unknown>,
): Record<string, unknown> {
  const { cleared } = resolveHiddenConditionals(fields, answers);
  if (cleared.size === 0) return answers;
  const next = { ...answers };
  for (const name of cleared) next[name] = null;
  return next;
}

// Fronteira (leitura/escrita de respostas persistidas): OMITE a chave de TODA
// condicional finalmente oculta — inclusive valores vazios (`null`/`""`) —, o
// que reproduz exatamente o `delete` incondicional que o `saveResponse` fazia
// antes do refactor e garante a invariante "respostas não contêm chave de
// condicional oculta". Centraliza essa invariante numa primitiva só, aplicada
// tanto no clean de leitura quanto na sanitização de escrita (ver #252).
// Avaliar visibilidade sobre o conjunto COMPLETO de campos (não filtrado por
// `target`), pois uma condição pode referenciar qualquer campo. Retorna o
// MESMO objeto quando nada há a omitir.
export function dropHiddenConditionals(
  fields: PydanticField[],
  answers: Record<string, unknown>,
): Record<string, unknown> {
  const { view } = resolveHiddenConditionals(fields, answers);
  // Reavalia sobre a view resolvida do ponto-fixo: uma chave presente cujo
  // campo condicional segue oculto é órfã, independente de o valor ser vazio.
  const orphans: string[] = [];
  for (const f of fields) {
    if (!f.condition) continue;
    if (!(f.name in answers)) continue;
    if (isFieldVisible(f, view)) continue;
    orphans.push(f.name);
  }
  if (orphans.length === 0) return answers;
  const next = { ...answers };
  for (const name of orphans) delete next[name];
  return next;
}

// Fronteira canônica de leitura de uma resposta humana persistida. O schema
// atual define, de uma só vez, quais chaves ainda existem, quais opções ainda
// são válidas e quais condicionais permanecem visíveis. Assim, uma mudança de
// schema não devolve ao editor valores órfãos, opções removidas ou campos que
// nunca foram destinados à codificação humana.
function sanitizeSingleOption(
  options: string[],
  value: unknown,
): string | undefined {
  return typeof value === "string" && options.includes(value)
    ? value
    : undefined;
}

function sanitizeMultipleOptions(
  options: string[],
  value: unknown,
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const allowed = new Set(options);
  const validValues = value.filter(
    (item): item is string =>
      typeof item === "string" && allowed.has(item),
  );
  return validValues.length > 0 ? validValues : undefined;
}

function sanitizeFieldValue(
  field: PydanticField,
  value: unknown,
): unknown {
  if (value === undefined || value === null) return undefined;
  if (field.type === "single" && field.options) {
    return sanitizeSingleOption(field.options, value);
  }
  if (field.type === "multi" && field.options) {
    return sanitizeMultipleOptions(field.options, value);
  }
  return value;
}

export function sanitizeHumanCodingAnswers(
  fields: PydanticField[],
  answers: Record<string, unknown>,
): Record<string, unknown> {
  const clean: Record<string, unknown> = {};

  for (const field of fields) {
    if (field.target === "llm_only" || field.target === "none") continue;
    const value = sanitizeFieldValue(field, answers[field.name]);
    if (value !== undefined) clean[field.name] = value;
  }

  // A visibilidade usa o schema completo: um campo destinado ao humano pode
  // depender de qualquer campo declarado no projeto.
  return dropHiddenConditionals(fields, clean);
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
