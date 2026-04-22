"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { saveSchemaFromGUI } from "./schema";
import type { PydanticField } from "@/lib/types";

export async function createSchemaSuggestion(
  projectId: string,
  fieldName: string,
  suggestedChanges: Record<string, unknown>,
  reason: string,
): Promise<{ error?: string }> {
  const user = await getAuthUser();
  if (!user) return { error: "Não autenticado" };

  const supabase = await createSupabaseServer();

  const { error } = await supabase.from("schema_suggestions").insert({
    project_id: projectId,
    field_name: fieldName,
    suggested_by: user.id,
    suggested_changes: suggestedChanges,
    reason: reason || null,
  });

  if (error) return { error: error.message };
  revalidatePath(`/projects/${projectId}/reviews/comments`);
  return {};
}

export async function resolveSchemaSuggestion(
  suggestionId: string,
  projectId: string,
  action: "approved" | "rejected",
  rejectionReason?: string,
): Promise<{ error?: string }> {
  const user = await getAuthUser();
  if (!user) return { error: "Não autenticado" };

  const supabase = await createSupabaseServer();

  if (action === "approved") {
    // Fetch the suggestion to get changes
    const { data: suggestion } = await supabase
      .from("schema_suggestions")
      .select("field_name, suggested_changes")
      .eq("id", suggestionId)
      .single();

    if (!suggestion) return { error: "Sugestão não encontrada" };

    // Fetch current fields
    const { data: project } = await supabase
      .from("projects")
      .select("pydantic_fields")
      .eq("id", projectId)
      .single();

    const fields = (project?.pydantic_fields as PydanticField[]) || [];
    const changes = suggestion.suggested_changes as Record<string, unknown>;

    // Apply changes to the matching field
    const updatedFields = fields.map((f) => {
      if (f.name !== suggestion.field_name) return f;
      return {
        ...f,
        ...(changes.description !== undefined && { description: changes.description as string }),
        ...(changes.help_text !== undefined && { help_text: (changes.help_text as string) || undefined }),
        ...(changes.options !== undefined && { options: (changes.options as string[])?.length ? changes.options as string[] : null }),
      };
    });

    // Save schema (triggers audit log)
    await saveSchemaFromGUI(projectId, updatedFields);
  }

  // Mark suggestion as resolved
  const { error } = await supabase
    .from("schema_suggestions")
    .update({
      status: action,
      resolved_by: user.id,
      resolved_at: new Date().toISOString(),
      ...(rejectionReason && { rejection_reason: rejectionReason }),
    })
    .eq("id", suggestionId);

  if (error) return { error: error.message };
  revalidatePath(`/projects/${projectId}/reviews/comments`);
  return {};
}

export async function approveSchemaSuggestionWithEdits(
  suggestionId: string,
  projectId: string,
  editedFields: PydanticField[],
): Promise<{ error?: string }> {
  const user = await getAuthUser();
  if (!user) return { error: "Não autenticado" };

  const supabase = await createSupabaseServer();

  await saveSchemaFromGUI(projectId, editedFields);

  const { error } = await supabase
    .from("schema_suggestions")
    .update({
      status: "approved",
      resolved_by: user.id,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", suggestionId);

  if (error) return { error: error.message };
  revalidatePath(`/projects/${projectId}/reviews/comments`);
  return {};
}
