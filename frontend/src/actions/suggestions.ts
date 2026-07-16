"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser, requireCoordinator } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { saveSchemaAndApproveSuggestion } from "./schema";
import type {
  PydanticField,
  SchemaBaselineIdentity,
  SchemaSaveResult,
} from "@/lib/types";
import { parsePydanticFields } from "@/lib/pydantic-field";
import {
  schemaSuggestionChangesSchema,
  type SchemaSuggestionChanges,
} from "@/lib/schema-suggestion";

function schemaSaveError(result: SchemaSaveResult): string | null {
  if (result.status === "saved") return null;
  if (result.status === "conflict") {
    return "O schema mudou enquanto a sugestão era revisada. Recarregue a página e reaplique a sugestão sobre a versão atual.";
  }
  return result.message;
}

type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServer>>;

async function applyApprovedSuggestion(
  supabase: SupabaseServerClient,
  suggestionId: string,
  projectId: string,
): Promise<string | null> {
  const { data: suggestion } = await supabase
    .from("schema_suggestions")
    .select("field_name, suggested_changes")
    .eq("id", suggestionId)
    .eq("project_id", projectId)
    .eq("status", "pending")
    .single();
  if (!suggestion) return "Sugestão não encontrada";

  const { data: project } = await supabase
    .from("projects")
    .select(
      "pydantic_fields, schema_revision",
    )
    .eq("id", projectId)
    .single();
  if (!project || project.schema_revision == null) {
    return "Projeto não encontrado ou sem permissão";
  }

  const parsedChanges = schemaSuggestionChangesSchema.safeParse(
    suggestion.suggested_changes,
  );
  if (!parsedChanges.success) return "A sugestão armazenada é inválida";
  const fields = parsePydanticFields(project.pydantic_fields);
  if (!fields) return "O schema persistido é inválido";
  const changes = parsedChanges.data;
  const updatedFields = fields.map((field) =>
    field.name === suggestion.field_name
      ? {
          ...field,
          ...(changes.description !== undefined && {
            description: changes.description,
          }),
          ...(changes.help_text !== undefined && {
            help_text: changes.help_text || undefined,
          }),
          ...(changes.options !== undefined && {
            options: changes.options?.length
              ? changes.options
              : null,
          }),
        }
      : field,
  );
  return schemaSaveError(
    await saveSchemaAndApproveSuggestion(projectId, suggestionId, updatedFields, {
      revision: project.schema_revision,
    }),
  );
}

export async function createSchemaSuggestion(
  projectId: string,
  fieldName: string,
  suggestedChanges: SchemaSuggestionChanges,
  reason: string,
): Promise<{ error?: string }> {
  const user = await getAuthUser();
  if (!user) return { error: "Não autenticado" };

  const parsedChanges = schemaSuggestionChangesSchema.safeParse(suggestedChanges);
  if (!parsedChanges.success) {
    return { error: "As alterações sugeridas são inválidas" };
  }

  const supabase = await createSupabaseServer();

  const { error } = await supabase.from("schema_suggestions").insert({
    project_id: projectId,
    field_name: fieldName,
    suggested_by: user.id,
    suggested_changes: parsedChanges.data,
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
  const user = gate.user;

  const supabase = await createSupabaseServer();

  if (action === "approved") {
    const saveError = await applyApprovedSuggestion(supabase, suggestionId, projectId);
    if (saveError) return { error: saveError };
    revalidatePath(`/projects/${projectId}/reviews/comments`);
    return {};
  }

  const { data: updated, error } = await supabase
    .from("schema_suggestions")
    .update({
      status: "rejected",
      resolved_by: user.id,
      resolved_at: new Date().toISOString(),
      ...(rejectionReason && { rejection_reason: rejectionReason }),
    })
    .eq("id", suggestionId)
    .eq("project_id", projectId)
    .eq("status", "pending")
    .select("id");

  if (error) return { error: error.message };
  if (!updated || updated.length === 0) {
    return {
      error: "Sem permissão para resolver esta sugestão.",
    };
  }
  revalidatePath(`/projects/${projectId}/reviews/comments`);
  return {};
}

export async function approveSchemaSuggestionWithEdits(
  suggestionId: string,
  projectId: string,
  editedFields: PydanticField[],
  expectedBaseline: SchemaBaselineIdentity,
): Promise<{ error?: string }> {
  const gate = await requireCoordinator(
    projectId,
    "Apenas coordenadores podem aprovar sugestões de schema.",
  );
  if (!gate.ok) return { error: gate.error };
  const saved = await saveSchemaAndApproveSuggestion(
    projectId,
    suggestionId,
    editedFields,
    expectedBaseline,
  );
  const saveError = schemaSaveError(saved);
  if (saveError) return { error: saveError };
  revalidatePath(`/projects/${projectId}/reviews/comments`);
  return {};
}
