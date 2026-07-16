"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import {
  requireCoordinator,
  resolveProjectActor,
} from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { saveSchemaFromGUI } from "./schema";
import type { PydanticField } from "@/lib/types";

type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServer>>;

async function applySuggestedSchema(
  supabase: SupabaseServerClient,
  suggestionId: string,
  projectId: string,
): Promise<{ error?: string }> {
  const { data: suggestion, error: suggestionError } = await supabase
    .from("schema_suggestions")
    .select("field_name, suggested_changes")
    .eq("id", suggestionId)
    .eq("project_id", projectId)
    .single();
  if (suggestionError) return { error: suggestionError.message };
  if (!suggestion) return { error: "Sugestão não encontrada" };

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("pydantic_fields")
    .eq("id", projectId)
    .single();
  if (projectError) return { error: projectError.message };
  if (!project) return { error: "Projeto não encontrado" };

  const changes = suggestion.suggested_changes as Record<string, unknown>;
  const fields = ((project.pydantic_fields as PydanticField[]) || []).map(
    (field) =>
      field.name === suggestion.field_name
        ? {
            ...field,
            ...(changes.description !== undefined && {
              description: changes.description as string,
            }),
            ...(changes.help_text !== undefined && {
              help_text: (changes.help_text as string) || undefined,
            }),
            ...(changes.options !== undefined && {
              options: (changes.options as string[])?.length
                ? (changes.options as string[])
                : null,
            }),
          }
        : field,
  );
  return saveSchemaFromGUI(projectId, fields);
}

async function markSuggestionResolved(
  supabase: SupabaseServerClient,
  suggestionId: string,
  projectId: string,
  actorId: string,
  status: "approved" | "rejected",
  rejectionReason?: string,
): Promise<{ error?: string }> {
  const { data: updated, error } = await supabase
    .from("schema_suggestions")
    .update({
      status,
      resolved_by: actorId,
      resolved_at: new Date().toISOString(),
      ...(rejectionReason && { rejection_reason: rejectionReason }),
    })
    .eq("id", suggestionId)
    .eq("project_id", projectId)
    .select("id");

  if (error) return { error: error.message };
  if (!updated || updated.length === 0) {
    return {
      error:
        status === "approved"
          ? "Schema aplicado, mas sem permissão para marcar a sugestão como aprovada."
          : "Sem permissão para resolver esta sugestão.",
    };
  }
  revalidatePath(`/projects/${projectId}/reviews/comments`);
  return {};
}

export async function createSchemaSuggestion(
  projectId: string,
  fieldName: string,
  suggestedChanges: Record<string, unknown>,
  reason: string,
): Promise<{ error?: string }> {
  const actor = await resolveProjectActor(projectId);
  if (!actor.ok) return { error: actor.error };
  const supabase = await createSupabaseServer();
  const actorId = actor.effectiveUserId;

  const { error } = await supabase.from("schema_suggestions").insert({
    project_id: projectId,
    field_name: fieldName,
    suggested_by: actorId,
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
  const gate = await requireCoordinator(
    projectId,
    "Apenas coordenadores podem resolver sugestões de schema.",
  );
  if (!gate.ok) return { error: gate.error };
  const supabase = await createSupabaseServer();
  const actorId = gate.effectiveUserId;

  if (action === "approved") {
    // Save schema (triggers audit log). Em falha (ex.: RLS filtrou o UPDATE
    // de projects — #178), retorna sem marcar a sugestão como aprovada,
    // evitando a divergência "Aprovada" com schema não aplicado.
    const saved = await applySuggestedSchema(supabase, suggestionId, projectId);
    if (saved.error) return { error: saved.error };
  }

  // Mark suggestion as resolved. O .select() detecta o caso inverso ao da
  // #178: schema já aplicado mas UPDATE de schema_suggestions filtrado pela
  // RLS (0 linhas) — sem o guard, a action retornaria sucesso com a sugestão
  // ainda "pendente".
  return markSuggestionResolved(
    supabase,
    suggestionId,
    projectId,
    actorId,
    action,
    rejectionReason,
  );
}

export async function approveSchemaSuggestionWithEdits(
  suggestionId: string,
  projectId: string,
  editedFields: PydanticField[],
): Promise<{ error?: string }> {
  const gate = await requireCoordinator(
    projectId,
    "Apenas coordenadores podem aprovar sugestões de schema.",
  );
  if (!gate.ok) return { error: gate.error };
  const supabase = await createSupabaseServer();
  const { data: suggestion, error: suggestionError } = await supabase
    .from("schema_suggestions")
    .select("id")
    .eq("id", suggestionId)
    .eq("project_id", projectId)
    .single();
  if (suggestionError) return { error: suggestionError.message };
  if (!suggestion) return { error: "Sugestão não encontrada" };

  const saved = await saveSchemaFromGUI(projectId, editedFields);
  const actorId = gate.effectiveUserId;
  if (saved.error) return { error: saved.error };

  return markSuggestionResolved(
    supabase,
    suggestionId,
    projectId,
    actorId,
    "approved",
  );
}
