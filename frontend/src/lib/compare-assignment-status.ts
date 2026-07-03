export type CompareAssignmentStatus = "pendente" | "em_andamento" | "concluido";

// Pure decision for the reviewer's "comparacao" assignment status, given the
// canonical divergent fields of the document and the set of fields the reviewer
// already has a verdict for. `every` is vacuously true for an empty divergent
// list, so a document with no divergences (e.g. all fused via equivalence)
// resolves to "concluido" instead of being stuck forever (#217).
export function resolveCompareStatus(
  divergentFields: string[],
  reviewedFields: Set<string>,
): CompareAssignmentStatus {
  if (divergentFields.every((fn) => reviewedFields.has(fn))) return "concluido";
  if (reviewedFields.size === 0) return "pendente";
  return "em_andamento";
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
