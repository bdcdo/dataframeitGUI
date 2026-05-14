import { normalizeForComparison } from "@/lib/utils";
import { isFieldVisible } from "@/lib/conditional";
import { buildResponseGroupKeys, type EquivalencePair } from "@/lib/equivalence";
import type { PydanticField } from "@/lib/types";

// A field is free-text when there is no fixed option set —
// equivalence makes sense only here. Multi/single-with-options have
// canonical answer keys already.
export function isFreeTextField(field: PydanticField): boolean {
  if (field.type === "text" || field.type === "date") return true;
  if (field.type === "single" && (!field.options || field.options.length === 0))
    return true;
  return false;
}

interface ResponseLike {
  id: string;
  answers: Record<string, unknown> | null | undefined;
  // Snapshot per-campo do schema contra o qual a response foi codificada
  // (1 chave por campo existente na época). Quando presente e a chave do campo
  // não está nele, aquele campo não existia quando a response foi codificada —
  // comparar geraria um falso "(vazio)" divergente. Ausente/null = legacy
  // (antes do mecanismo de hashes): não dá para inferir, mantém comportamento
  // antigo de incluir a response.
  answerFieldHashes?: Record<string, string> | null;
}

// True a menos que a response comprovadamente não tivesse o campo no schema
// contra o qual foi codificada (answer_field_hashes presente e sem a chave).
function responseHadField(r: ResponseLike, fieldName: string): boolean {
  if (!r.answerFieldHashes) return true;
  return Object.prototype.hasOwnProperty.call(r.answerFieldHashes, fieldName);
}

// Returns the names of fields whose responses diverge.
// `equivalencesByField` maps fieldName -> list of equivalence pairs for that
// (document, field). When provided, free-text fields use union-find class keys
// instead of raw normalized values, fusing equivalent answers.
export function computeDivergentFieldNames(
  fields: PydanticField[],
  responses: ResponseLike[],
  equivalencesByField?: Map<string, EquivalencePair[]>,
): string[] {
  const divergent: string[] = [];

  for (const field of fields) {
    if (
      field.target === "llm_only" ||
      field.target === "human_only" ||
      field.target === "none"
    )
      continue;

    const applicable = responses.filter((r) => {
      if (!responseHadField(r, field.name)) return false;
      if (
        field.condition &&
        !isFieldVisible(field, (r.answers as Record<string, unknown>) ?? {})
      )
        return false;
      return true;
    });
    if (applicable.length < 2) continue;

    if (field.type === "multi" && field.options?.length) {
      const opts = new Set<string>(field.options);
      for (const r of applicable) {
        const arr = (r.answers as Record<string, unknown>)?.[field.name];
        if (Array.isArray(arr)) {
          for (const v of arr) if (typeof v === "string") opts.add(v);
        }
      }
      let hasDivergence = false;
      for (const opt of opts) {
        const sels = applicable.map((r) => {
          const arr = (r.answers as Record<string, unknown>)?.[field.name];
          return Array.isArray(arr) && arr.includes(opt);
        });
        if (sels.length > 0 && !sels.every((s) => s === sels[0])) {
          hasDivergence = true;
          break;
        }
      }
      if (hasDivergence) divergent.push(field.name);
      continue;
    }

    // Scalar / free-text path. For free-text we run union-find over both
    // explicit pairs and same-normalized-answer edges, so responses with
    // identical text always land in the same group regardless of pairs.
    if (isFreeTextField(field)) {
      const pairs = equivalencesByField?.get(field.name) ?? [];
      const items = applicable.map((r) => ({
        id: r.id,
        answer: (r.answers as Record<string, unknown>)?.[field.name],
      }));
      const groupKeys = buildResponseGroupKeys(items, pairs, (r) =>
        normalizeForComparison(r.answer),
      );
      const keys = new Set<string>();
      for (const r of applicable) keys.add(groupKeys.get(r.id) ?? r.id);
      if (keys.size > 1) divergent.push(field.name);
      continue;
    }

    const keys = new Set<string>();
    for (const r of applicable) {
      const raw = (r.answers as Record<string, unknown>)?.[field.name];
      keys.add(normalizeForComparison(raw));
    }
    if (keys.size > 1) divergent.push(field.name);
  }

  return divergent;
}

// A document is "complete" in the Compare queue when it has at least one
// divergent field and every divergent field already has a verdict.
export function isDocComplete(
  divergentForDoc: string[] | undefined,
  reviewsForDoc: Record<string, unknown> | undefined,
): boolean {
  if (!divergentForDoc || divergentForDoc.length === 0) return false;
  if (!reviewsForDoc) return false;
  return divergentForDoc.every((fn) => !!reviewsForDoc[fn]);
}

// Index of the next document that still has unreviewed divergences, scanning
// the queue in its current order and skipping `currentDocId`. Returns -1 when
// every other document is complete. The server re-sorts the queue on each
// revalidate (completed docs sink to the bottom), so "next parecer" must be
// found by completion state — never by `currentIndex + 1`.
export function findNextPendingDocIndex(
  docIds: string[],
  divergentFields: Record<string, string[]>,
  reviews: Record<string, Record<string, unknown>>,
  currentDocId: string | undefined,
): number {
  return docIds.findIndex(
    (id) =>
      id !== currentDocId && !isDocComplete(divergentFields[id], reviews[id]),
  );
}
