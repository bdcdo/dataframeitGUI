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
    if (!Object.hasOwn(current, part)) return undefined;
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

// Cliente (estado vivo de codificação): zera para `null` as respostas de
// condicionais ocultas. É também o núcleo da fronteira abaixo, que lê a
// visibilidade final nesta mesma view. Ponto-fixo: limpar uma condicional pode
// esconder outra que dependia dela, então iteramos até estabilizar. Trabalha sobre uma
// view copy-on-write (clona só na primeira limpeza), marcando cada órfão com
// valor como `null` para reavaliar a visibilidade em cascata — `null` e chave
// ausente são equivalentes para `isFieldVisible`. `""` também é zerado: para
// `not_equals`/`not_in` ele é valor, e mantê-lo deixava visível na view o
// dependente de um gatilho oculto — a tela mostrava a pergunta e a fronteira,
// que lê esta mesma view, guardava a resposta dele enquanto omitia o gatilho.
// Só `null` e ausente ficam de fora: zerá-los não muda nada, e é isso que
// garante a terminação (cada passada troca ao menos um valor não nulo por
// `null`). Não muta a entrada e devolve o MESMO objeto quando nada muda,
// preservando a identidade referencial que o React usa para evitar re-renders.
function isHiddenWithValue(
  field: PydanticField,
  view: Record<string, unknown>,
): boolean {
  if (!field.condition || isFieldVisible(field, view)) return false;
  return Object.hasOwn(view, field.name) && view[field.name] != null;
}

export function clearHiddenConditionalAnswers(
  fields: PydanticField[],
  answers: Record<string, unknown>,
): Record<string, unknown> {
  let view = answers;
  let changed = true;
  while (changed) {
    changed = false;
    // Sequencial de propósito: o campo seguinte da mesma passada já vê o
    // anterior zerado (com `exists: false`, isso o torna visível).
    for (const f of fields) {
      if (!isHiddenWithValue(f, view)) continue;
      if (view === answers) view = { ...answers };
      view[f.name] = null;
      changed = true;
    }
  }
  return view;
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
//
// A visibilidade final é lida na view resolvida do mesmo ponto-fixo do estado
// vivo, e não decidida durante a cascata: com o dependente antes do gatilho
// (o editor permite arrastar) e `exists: false`, omitir o gatilho oculto torna
// o dependente visível, e uma omissão feita enquanto o gatilho ainda estava
// presente não se desfaz. Ler da view também faz a tela e o save concordarem
// por construção.
export function dropHiddenConditionals(
  fields: PydanticField[],
  answers: Record<string, unknown>,
): Record<string, unknown> {
  const view = clearHiddenConditionalAnswers(fields, answers);
  // Uma chave presente cujo campo condicional segue oculto na view resolvida é
  // órfã, independente de o valor ser vazio.
  const orphans: string[] = [];
  for (const f of fields) {
    if (!f.condition) continue;
    if (!Object.hasOwn(answers, f.name)) continue;
    if (isFieldVisible(f, view)) continue;
    orphans.push(f.name);
  }
  if (orphans.length === 0) return answers;
  const next = { ...answers };
  for (const name of orphans) delete next[name];
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
