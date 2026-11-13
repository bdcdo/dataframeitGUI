import {
  currentValueEquivalences,
  equivalenceValueKey,
  valueClassKeys,
  type ValueEquivalence,
} from "@/lib/equivalence";
import { answersCurrentQuestion } from "@/lib/answer-staleness";
import { resolveDocTitle } from "@/lib/utils";
import type { AnswerFieldHashes, PydanticField } from "@/lib/types";

// Leitura da aba "Equivalências": as equivalências de um campo agrupadas pelas
// classes que elas formam (A=B e B=C são uma classe só) e os documentos em que
// cada classe de fato funde respostas. Puro: quem chama traz as equivalências
// já recortadas pela versão atual da pergunta (`currentValueEquivalences`).

export interface EquivalenceClassView<T extends ValueEquivalence = ValueEquivalence> {
  /** Chave estável da classe (a menor chave normalizada de valor). */
  classKey: string;
  /** Um valor bruto por chave normalizada, na ordem em que aparecem. */
  values: unknown[];
  equivalences: T[];
}

export function equivalenceClasses<T extends ValueEquivalence>(
  equivalences: readonly T[],
): EquivalenceClassView<T>[] {
  const classOf = valueClassKeys(equivalences);
  const byClass = new Map<string, EquivalenceClassView<T> & { seen: Set<string> }>();
  for (const equivalence of equivalences) {
    const keyA = equivalenceValueKey(equivalence.value_a);
    const classKey = classOf.get(keyA) ?? keyA;
    let view = byClass.get(classKey);
    if (!view) {
      view = { classKey, values: [], equivalences: [], seen: new Set() };
      byClass.set(classKey, view);
    }
    view.equivalences.push(equivalence);
    for (const value of [equivalence.value_a, equivalence.value_b]) {
      const key = equivalenceValueKey(value);
      if (view.seen.has(key)) continue;
      view.seen.add(key);
      view.values.push(value);
    }
  }
  return [...byClass.values()]
    .map(({ classKey, values, equivalences: members }) => ({ classKey, values, equivalences: members }))
    .toSorted((a, b) => b.equivalences.length - a.equivalences.length || a.classKey.localeCompare(b.classKey));
}

export interface FieldAnswerRow {
  document_id: string;
  value: unknown;
  /** A resposta foi dada à versão atual da pergunta (`answersCurrentQuestion`). */
  answersCurrentQuestion: boolean;
}

/**
 * Por classe, os documentos em que ela funde respostas: ao menos dois valores
 * DISTINTOS da classe (pela chave normalizada) entre as respostas vigentes do
 * documento dadas à versão atual da pergunta. Documento em que todos dizem o
 * mesmo valor não depende da equivalência.
 */
export function documentsWhereClassesApply(
  equivalences: readonly ValueEquivalence[],
  rows: readonly FieldAnswerRow[],
): Map<string, string[]> {
  const classOf = valueClassKeys(equivalences);
  const keysByDocClass = new Map<string, Map<string, Set<string>>>();
  for (const row of rows) {
    if (!row.answersCurrentQuestion || row.value === undefined) continue;
    const key = equivalenceValueKey(row.value);
    const classKey = classOf.get(key);
    if (classKey === undefined) continue;
    let byDoc = keysByDocClass.get(classKey);
    if (!byDoc) {
      byDoc = new Map();
      keysByDocClass.set(classKey, byDoc);
    }
    const keys = byDoc.get(row.document_id) ?? new Set<string>();
    keys.add(key);
    byDoc.set(row.document_id, keys);
  }
  const result = new Map<string, string[]>();
  for (const [classKey, byDoc] of keysByDocClass) {
    const documents = [...byDoc].filter(([, keys]) => keys.size >= 2).map(([documentId]) => documentId);
    if (documents.length > 0) result.set(classKey, documents.toSorted());
  }
  return result;
}

export interface UsageDocument {
  id: string;
  title: string;
}

/**
 * "Onde se aplica" da aba Equivalências: por classe das equivalências da
 * versão atual da pergunta, os documentos (com título) em que ela funde
 * respostas. `rows` são as respostas vigentes ao campo, só com o valor dele.
 */
export function equivalenceUsageByClass(
  rows: ReadonlyArray<{
    document_id: string;
    value: unknown;
    answer_field_hashes: AnswerFieldHashes | null;
    documents: { title: string | null; external_id: string | null } | null;
  }>,
  equivalences: readonly ValueEquivalence[],
  field: PydanticField | undefined,
): Record<string, UsageDocument[]> {
  const titles = new Map(
    rows.map((row) => [
      row.document_id,
      resolveDocTitle(row.documents?.title ?? null, row.documents?.external_id ?? null, row.document_id),
    ]),
  );
  const byClass = documentsWhereClassesApply(
    currentValueEquivalences(equivalences, field),
    rows.map((row) => ({
      document_id: row.document_id,
      value: row.value,
      answersCurrentQuestion: answersCurrentQuestion(row.answer_field_hashes, field),
    })),
  );
  const usage: Record<string, UsageDocument[]> = {};
  for (const [classKey, documentIds] of byClass) {
    usage[classKey] = documentIds.map((id) => ({ id, title: titles.get(id) ?? id }));
  }
  return usage;
}
