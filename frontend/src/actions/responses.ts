"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { revalidatePath, revalidateTag } from "next/cache";
import type { PydanticField } from "@/lib/types";

export async function saveResponse(
  projectId: string,
  documentId: string,
  answers: Record<string, unknown>,
  notes?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const user = await getAuthUser();
    if (!user) return { success: false, error: "Não autenticado" };

    const supabase = await createSupabaseServer();

    // Fetch profile, existing response, and project config in parallel
    const [{ data: profile }, { data: existing }, { data: project, error: projErr }] = await Promise.all([
      supabase
        .from("profiles")
        .select("first_name, last_name")
        .eq("id", user.id)
        .single(),
      supabase
        .from("responses")
        .select("id")
        .eq("project_id", projectId)
        .eq("document_id", documentId)
        .eq("respondent_id", user.id)
        .eq("respondent_type", "humano")
        .single(),
      supabase
        .from("projects")
        .select(
          "pydantic_hash, pydantic_fields, schema_version_major, schema_version_minor, schema_version_patch",
        )
        .eq("id", projectId)
        .single(),
    ]);

    if (projErr) return { success: false, error: projErr.message };

    const respondentName = [profile?.first_name, profile?.last_name]
      .filter(Boolean)
      .join(" ") || user.email;

    const justifications = notes ? { _notes: notes } : null;

    // Build per-field hash snapshot for staleness detection
    const fields = (project?.pydantic_fields as PydanticField[]) || [];
    const answerFieldHashes: Record<string, string> = {};
    for (const f of fields) {
      if (f.hash) answerFieldHashes[f.name] = f.hash;
    }

    const responsePayload = {
      answers,
      justifications,
      pydantic_hash: project?.pydantic_hash ?? null,
      answer_field_hashes: answerFieldHashes,
      schema_version_major: project?.schema_version_major ?? 0,
      schema_version_minor: project?.schema_version_minor ?? 1,
      schema_version_patch: project?.schema_version_patch ?? 0,
      version_inferred_from: "live_save",
    };

    if (existing) {
      const { error: updateErr } = await supabase
        .from("responses")
        .update(responsePayload)
        .eq("id", existing.id);
      if (updateErr) return { success: false, error: updateErr.message };
    } else {
      const { error: insertErr } = await supabase.from("responses").insert({
        project_id: projectId,
        document_id: documentId,
        respondent_id: user.id,
        respondent_type: "humano",
        respondent_name: respondentName,
        is_current: true,
        ...responsePayload,
      });
      if (insertErr) return { success: false, error: insertErr.message };
    }

    if (fields.length > 0) {
      const humanFields = fields.filter(
        (f) => (f.target || "all") !== "llm_only" && f.required !== false
      );
      const OTHER_PREFIX = "Outro: ";
      const isIncompleteOther = (v: unknown) =>
        typeof v === "string" && v === OTHER_PREFIX;
      const allAnswered = humanFields.every((f) => {
        const v = answers[f.name];
        if (v === undefined || v === null || v === "") return false;
        if (f.type === "single" && isIncompleteOther(v)) return false;
        if (f.type === "multi" && Array.isArray(v)) {
          if (v.length === 0) return false;
          if (v.some(isIncompleteOther)) return false;
        }
        return true;
      });

      if (allAnswered) {
        const { error: assignErr } = await supabase
          .from("assignments")
          .update({ status: "concluido", completed_at: new Date().toISOString() })
          .eq("project_id", projectId)
          .eq("document_id", documentId)
          .eq("user_id", user.id)
          .eq("type", "codificacao");
        if (assignErr) return { success: false, error: assignErr.message };
      } else {
        // So regredir se NAO esta concluido (evita desfazer progresso por auto-save)
        const { data: currentAssignment } = await supabase
          .from("assignments")
          .select("status")
          .eq("project_id", projectId)
          .eq("document_id", documentId)
          .eq("user_id", user.id)
          .eq("type", "codificacao")
          .maybeSingle();

        if (currentAssignment && currentAssignment.status !== "concluido") {
          const { error: assignErr } = await supabase
            .from("assignments")
            .update({ status: "em_andamento", completed_at: null })
            .eq("project_id", projectId)
            .eq("document_id", documentId)
            .eq("user_id", user.id)
            .eq("type", "codificacao");
          if (assignErr) return { success: false, error: assignErr.message };
        }
      }
    }

    revalidatePath(`/projects/${projectId}/analyze/code`);
    revalidatePath(`/projects/${projectId}/analyze/compare`);
    revalidatePath(`/projects/${projectId}/reviews`);
    revalidateTag(`project-${projectId}-progress`, { expire: 60 });
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Erro desconhecido" };
  }
}
