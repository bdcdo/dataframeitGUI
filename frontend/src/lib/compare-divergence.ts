import { normalizeForComparison } from "@/lib/utils";
import { isFieldVisible } from "@/lib/conditional";
import { buildEquivalenceClasses, type EquivalencePair } from "@/lib/equivalence";
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

    const applicable = field.condition
      ? responses.filter((r) =>
          isFieldVisible(field, (r.answers as Record<string, unknown>) ?? {}),
        )
      : responses;
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

    // Scalar / free-text path.
    const useEquivalences =
      isFreeTextField(field) && equivalencesByField?.has(field.name);
    let classes: Map<string, string> | null = null;
    if (useEquivalences) {
      classes = buildEquivalenceClasses(
        applicable.map((r) => r.id),
        equivalencesByField!.get(field.name) ?? [],
      );
    }

    const keys = new Set<string>();
    for (const r of applicable) {
      const raw = (r.answers as Record<string, unknown>)?.[field.name];
      if (classes) {
        // Equivalence-aware key: classKey + answer; this way two responses
        // are only fused when the reviewer explicitly marked them so.
        // Responses outside any pair land in a class of their own (id == classKey)
        // and we still distinguish them by their normalized answer.
        const classKey = classes.get(r.id) ?? r.id;
        const pairs = equivalencesByField!.get(field.name) ?? [];
        const isInAnyPair = pairs.some(
          (p) => p.response_a_id === r.id || p.response_b_id === r.id,
        );
        keys.add(
          isInAnyPair ? `eq:${classKey}` : `raw:${normalizeForComparison(raw)}`,
        );
      } else {
        keys.add(normalizeForComparison(raw));
      }
    }
    if (keys.size > 1) divergent.push(field.name);
  }

  return divergent;
}
