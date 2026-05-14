import "server-only";

import type { createSupabaseServer } from "@/lib/supabase/server";
import type { PydanticField } from "@/lib/types";
import {
  computeDivergentFieldNames,
  isFreeTextField,
} from "@/lib/compare-divergence";
import type { EquivalencePair } from "@/lib/equivalence";

// Recomputes assignment status (pendente / em_andamento / concluido) for the
// reviewer's "comparacao" assignment on this document, taking into account
// any equivalences registered between responses for free-text fields.
export async function syncCompareAssignment(
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
  projectId: string,
  documentId: string,
  userId: string,
) {
  const { data: assignment } = await supabase
    .from("assignments")
    .select("id, status")
    .eq("project_id", projectId)
    .eq("document_id", documentId)
    .eq("user_id", userId)
    .eq("type", "comparacao")
    .maybeSingle();

  if (!assignment) return;

  const [
    { data: project },
    { data: responses },
    { data: reviews },
    { data: equivalences },
  ] = await Promise.all([
    supabase
      .from("projects")
      .select("pydantic_fields")
      .eq("id", projectId)
      .single(),
    supabase
      .from("responses")
      .select("id, respondent_type, is_latest, answers")
      .eq("project_id", projectId)
      .eq("document_id", documentId),
    supabase
      .from("reviews")
      .select("field_name")
      .eq("project_id", projectId)
      .eq("document_id", documentId)
      .eq("reviewer_id", userId),
    supabase
      .from("response_equivalences")
      .select("field_name, response_a_id, response_b_id")
      .eq("project_id", projectId)
      .eq("document_id", documentId),
  ]);

  const reviewedFields = new Set((reviews ?? []).map((r) => r.field_name));

  if (reviewedFields.size === 0) {
    if (assignment.status !== "pendente") {
      await supabase
        .from("assignments")
        .update({ status: "pendente", completed_at: null })
        .eq("id", assignment.id);
    }
    return;
  }

  const fields = (project?.pydantic_fields as PydanticField[]) || [];
  type ActiveResponse = {
    id: string;
    answers: Record<string, unknown>;
  };
  const activeResponses: ActiveResponse[] = (responses ?? [])
    .filter((r) => r.is_latest || r.respondent_type === "humano")
    .map((r) => ({
      id: r.id,
      answers: (r.answers ?? {}) as Record<string, unknown>,
    }));

  const equivalencesByField = new Map<string, EquivalencePair[]>();
  for (const eq of equivalences ?? []) {
    if (!equivalencesByField.has(eq.field_name)) {
      equivalencesByField.set(eq.field_name, []);
    }
    equivalencesByField.get(eq.field_name)!.push({
      response_a_id: eq.response_a_id,
      response_b_id: eq.response_b_id,
    });
  }

  const divergentFields = computeDivergentFieldNames(
    fields,
    activeResponses,
    equivalencesByField,
  );

  const allReviewed =
    divergentFields.length > 0 &&
    divergentFields.every((fn) => reviewedFields.has(fn));

  if (allReviewed) {
    if (assignment.status !== "concluido") {
      await supabase
        .from("assignments")
        .update({ status: "concluido", completed_at: new Date().toISOString() })
        .eq("id", assignment.id);
    }
  } else if (assignment.status === "pendente") {
    await supabase
      .from("assignments")
      .update({ status: "em_andamento" })
      .eq("id", assignment.id);
  }
}

export { isFreeTextField };
