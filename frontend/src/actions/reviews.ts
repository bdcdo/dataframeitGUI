"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { normalizeForComparison } from "@/lib/utils";
import type { PydanticField } from "@/lib/types";

export interface ResponseSnapshotEntry {
  id: string;
  respondent_name: string;
  respondent_type: "humano" | "llm";
  answer: unknown;
  justification?: string;
}

async function syncCompareAssignment(
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

  const [{ data: project }, { data: responses }, { data: reviews }] = await Promise.all([
    supabase
      .from("projects")
      .select("pydantic_fields")
      .eq("id", projectId)
      .single(),
    supabase
      .from("responses")
      .select("respondent_type, is_current, answers")
      .eq("project_id", projectId)
      .eq("document_id", documentId),
    supabase
      .from("reviews")
      .select("field_name")
      .eq("project_id", projectId)
      .eq("document_id", documentId)
      .eq("reviewer_id", userId),
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
  const activeResponses = (responses ?? []).filter(
    (r) => r.is_current || r.respondent_type === "humano",
  );

  const divergentFields: string[] = [];
  for (const field of fields) {
    if (field.target === "llm_only" || field.target === "human_only") continue;

    if (field.type === "multi" && field.options?.length) {
      const opts = new Set<string>(field.options);
      for (const r of activeResponses) {
        const arr = (r.answers as Record<string, unknown>)?.[field.name];
        if (Array.isArray(arr)) {
          for (const v of arr) if (typeof v === "string") opts.add(v);
        }
      }
      let hasDivergence = false;
      for (const opt of opts) {
        const sels = activeResponses.map((r) => {
          const arr = (r.answers as Record<string, unknown>)?.[field.name];
          return Array.isArray(arr) && arr.includes(opt);
        });
        if (!sels.every((s) => s === sels[0])) {
          hasDivergence = true;
          break;
        }
      }
      if (hasDivergence) divergentFields.push(field.name);
    } else {
      const ans = activeResponses.map(
        (r) => (r.answers as Record<string, unknown>)?.[field.name],
      );
      const unique = new Set(ans.map((a) => normalizeForComparison(a)));
      if (unique.size > 1) divergentFields.push(field.name);
    }
  }

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

export async function submitVerdict(
  projectId: string,
  documentId: string,
  fieldName: string,
  verdict: string,
  chosenResponseId?: string,
  comment?: string,
  responseSnapshot?: ResponseSnapshotEntry[],
) {
  const user = await getAuthUser();
  if (!user) throw new Error("Não autenticado");

  const supabase = await createSupabaseServer();

  const { error } = await supabase.from("reviews").upsert(
    {
      project_id: projectId,
      document_id: documentId,
      field_name: fieldName,
      reviewer_id: user.id,
      verdict,
      chosen_response_id: chosenResponseId || null,
      comment: comment || null,
      response_snapshot: responseSnapshot ?? null,
    },
    {
      onConflict: "project_id,document_id,field_name,reviewer_id",
    }
  );

  if (error) throw new Error(error.message);

  await syncCompareAssignment(supabase, projectId, documentId, user.id);

  revalidatePath(`/projects/${projectId}/analyze/compare`);
  revalidatePath(`/projects/${projectId}/analyze/assignments`);
}

// Para docs sem divergência (revisor decide fechar manualmente).
export async function markCompareDocReviewed(
  projectId: string,
  documentId: string,
) {
  const user = await getAuthUser();
  if (!user) throw new Error("Não autenticado");

  const supabase = await createSupabaseServer();

  const { error } = await supabase
    .from("assignments")
    .update({ status: "concluido", completed_at: new Date().toISOString() })
    .eq("project_id", projectId)
    .eq("document_id", documentId)
    .eq("user_id", user.id)
    .eq("type", "comparacao");

  if (error) throw new Error(error.message);

  revalidatePath(`/projects/${projectId}/analyze/compare`);
  revalidatePath(`/projects/${projectId}/analyze/assignments`);
}
