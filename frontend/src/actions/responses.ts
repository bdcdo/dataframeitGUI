"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import type { PydanticField } from "@/lib/types";

export async function saveResponse(
  projectId: string,
  documentId: string,
  answers: Record<string, unknown>,
  notes?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createSupabaseServer();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { success: false, error: "Não autenticado" };

    // Fetch profile and existing response in parallel
    const [{ data: profile }, { data: existing }] = await Promise.all([
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
    ]);

    const respondentName = [profile?.first_name, profile?.last_name]
      .filter(Boolean)
      .join(" ") || user.email;

    const justifications = notes ? { _notes: notes } : null;

    if (existing) {
      const { error: updateErr } = await supabase
        .from("responses")
        .update({ answers, justifications })
        .eq("id", existing.id);
      if (updateErr) return { success: false, error: updateErr.message };
    } else {
      const { error: insertErr } = await supabase.from("responses").insert({
        project_id: projectId,
        document_id: documentId,
        respondent_id: user.id,
        respondent_type: "humano",
        respondent_name: respondentName,
        answers,
        justifications,
        is_current: true,
      });
      if (insertErr) return { success: false, error: insertErr.message };
    }

    // Check if all fields answered -> update assignment status
    const { data: project, error: projErr } = await supabase
      .from("projects")
      .select("pydantic_fields")
      .eq("id", projectId)
      .single();
    if (projErr) return { success: false, error: projErr.message };

    if (project?.pydantic_fields) {
      const fields = project.pydantic_fields as PydanticField[];
      const humanFields = fields.filter(
        (f) => (f.target || "all") !== "llm_only" && f.required !== false
      );
      const allAnswered = humanFields.every(
        (f) => answers[f.name] !== undefined && answers[f.name] !== null && answers[f.name] !== ""
      );

      if (allAnswered) {
        const { error: assignErr } = await supabase
          .from("assignments")
          .update({ status: "concluido", completed_at: new Date().toISOString() })
          .eq("project_id", projectId)
          .eq("document_id", documentId)
          .eq("user_id", user.id);
        if (assignErr) return { success: false, error: assignErr.message };
      } else {
        // So regredir se NAO esta concluido (evita desfazer progresso por auto-save)
        const { data: currentAssignment } = await supabase
          .from("assignments")
          .select("status")
          .eq("project_id", projectId)
          .eq("document_id", documentId)
          .eq("user_id", user.id)
          .single();

        if (currentAssignment && currentAssignment.status !== "concluido") {
          const { error: assignErr } = await supabase
            .from("assignments")
            .update({ status: "em_andamento", completed_at: null })
            .eq("project_id", projectId)
            .eq("document_id", documentId)
            .eq("user_id", user.id);
          if (assignErr) return { success: false, error: assignErr.message };
        }
      }
    }

    revalidatePath(`/projects/${projectId}`, "layout");
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Erro desconhecido" };
  }
}
