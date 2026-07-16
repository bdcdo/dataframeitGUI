import { buildFieldHashMap } from "@/lib/answer-staleness";
import { dropHiddenConditionals } from "@/lib/conditional";
import { isOtherValue } from "@/lib/other-option";
import { stableStringify } from "@/lib/schema-utils";
import type { AnswerFieldHashes, PydanticField } from "@/lib/types";

const hasOwn = (value: object, key: string): boolean => Object.hasOwn(value, key);

function humanFields(fields: PydanticField[]): PydanticField[] {
  return fields.filter((field) => field.target !== "llm_only" && field.target !== "none");
}

function isAllowedOption(field: PydanticField, value: unknown): value is string {
  return (
    (typeof value === "string" && (field.options ?? []).includes(value)) ||
    (field.allow_other === true && isOtherValue(value))
  );
}

function keepIfStillPresentable(field: PydanticField, value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (!field.options) return value;
  if (field.type === "single") {
    return isAllowedOption(field, value) ? value : undefined;
  }
  if (field.type === "multi") {
    const kept = Array.isArray(value) ? value.filter((item) => isAllowedOption(field, item)) : [];
    return kept.length > 0 ? kept : undefined;
  }
  return value;
}

// Projeção canônica das respostas armazenadas que pode ser exibida pelo
// formulário atual. O valor bruto permanece no banco até que o pesquisador
// altere explicitamente a projeção apresentada.
export function sanitizeStoredAnswers(
  allFields: PydanticField[],
  answers: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!answers) return {};
  if (allFields.length === 0) return answers;

  const entries: Array<[string, unknown]> = [];
  for (const field of humanFields(allFields)) {
    if (!hasOwn(answers, field.name)) continue;
    const kept = keepIfStillPresentable(field, answers[field.name]);
    if (kept !== undefined) entries.push([field.name, kept]);
  }
  const clean = Object.fromEntries(entries) as Record<string, unknown>;
  return dropHiddenConditionals(allFields, clean);
}

export interface PersistedResponseSnapshot {
  submittedAnswers: Record<string, unknown>;
  persistedAnswers: Record<string, unknown>;
  answerFieldHashes: Exclude<AnswerFieldHashes, null>;
}

interface BuildPersistedResponseSnapshotParams {
  fields: PydanticField[];
  storedAnswers: Record<string, unknown> | null | undefined;
  storedHashes: AnswerFieldHashes | undefined;
  rawSubmittedAnswers: Record<string, unknown>;
}

function samePresentedValue(
  presented: Record<string, unknown>,
  submitted: Record<string, unknown>,
  fieldName: string,
): boolean {
  const wasPresented = hasOwn(presented, fieldName);
  const wasSubmitted = hasOwn(submitted, fieldName);
  if (wasPresented !== wasSubmitted) return false;
  if (!wasPresented) return true;
  return stableStringify(presented[fieldName]) === stableStringify(submitted[fieldName]);
}

function reconcileAnswers(
  storedAnswers: Record<string, unknown> | null | undefined,
  presentedAnswers: Record<string, unknown>,
  submittedAnswers: Record<string, unknown>,
): { persistedAnswers: Record<string, unknown>; changedFieldNames: Set<string> } {
  const persistedAnswers: Record<string, unknown> = storedAnswers ? { ...storedAnswers } : {};
  const changedFieldNames = new Set<string>();
  const comparedFieldNames = new Set([
    ...Object.keys(presentedAnswers),
    ...Object.keys(submittedAnswers),
  ]);

  for (const fieldName of comparedFieldNames) {
    if (samePresentedValue(presentedAnswers, submittedAnswers, fieldName)) continue;
    changedFieldNames.add(fieldName);
    if (hasOwn(submittedAnswers, fieldName)) {
      persistedAnswers[fieldName] = submittedAnswers[fieldName];
    } else {
      delete persistedAnswers[fieldName];
    }
  }
  return { persistedAnswers, changedFieldNames };
}

function buildReconciledFieldHashes(
  fields: PydanticField[],
  storedAnswers: Record<string, unknown> | null | undefined,
  storedHashes: AnswerFieldHashes | undefined,
  persistedAnswers: Record<string, unknown>,
  changedFieldNames: Set<string>,
): Exclude<AnswerFieldHashes, null> {
  const hashes = buildFieldHashMap(fields);
  for (const fieldName of Object.keys(storedAnswers ?? {})) {
    if (changedFieldNames.has(fieldName) || !hasOwn(persistedAnswers, fieldName)) continue;
    hashes[fieldName] = storedHashes && hasOwn(storedHashes, fieldName) ? storedHashes[fieldName] : null;
  }
  for (const fieldName of Object.keys(persistedAnswers)) {
    if (!hasOwn(hashes, fieldName)) hashes[fieldName] = null;
  }
  return hashes;
}

// Reconcilia o snapshot armazenado com o formulário atual sem confundir
// "trafegou no formulário" com "foi revisado". Respostas e hashes são
// produzidos juntos para não permitir proveniência incompatível com o valor.
export function buildPersistedResponseSnapshot({
  fields,
  storedAnswers,
  storedHashes,
  rawSubmittedAnswers,
}: BuildPersistedResponseSnapshotParams): PersistedResponseSnapshot {
  // A leitura sem schema expõe o JSON bruto por compatibilidade, mas não há
  // controles capazes de representar essas chaves no formulário. Portanto,
  // um submit vazio não pode ser interpretado como pedido para apagá-las.
  const presentedAnswers = fields.length === 0 ? {} : sanitizeStoredAnswers(fields, storedAnswers);
  const submittedAnswers = dropHiddenConditionals(fields, rawSubmittedAnswers);
  const { persistedAnswers, changedFieldNames } = reconcileAnswers(
    storedAnswers,
    presentedAnswers,
    submittedAnswers,
  );
  const answerFieldHashes = buildReconciledFieldHashes(
    fields,
    storedAnswers,
    storedHashes,
    persistedAnswers,
    changedFieldNames,
  );

  return { submittedAnswers, persistedAnswers, answerFieldHashes };
}
