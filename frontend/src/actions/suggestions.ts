"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser, requireCoordinator } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { saveSchemaFromGUI } from "./schema";
import type {
  PydanticField,
  SchemaBaselineIdentity,
  SchemaSaveResult,
} from "@/lib/types";

function projectVersion(project: {
  schema_version_major?: number | null;
  schema_version_minor?: number | null;
  schema_version_patch?: number | null;
}): string {
  return `${project.schema_version_major ?? 0}.${project.schema_version_minor ?? 1}.${project.schema_version_patch ?? 0}`;
}

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
    .single();
  if (!suggestion) return "Sugestão não encontrada";

  const { data: project } = await supabase
    .from("projects")
    .select(
      "pydantic_fields, schema_version_major, schema_version_minor, schema_version_patch, schema_revision",
    )
    .eq("id", projectId)
    .single();
  if (!project || project.schema_revision == null) {
    return "Projeto não encontrado ou sem permissão";
  }

  const changes = suggestion.suggested_changes as Record<string, unknown>;
  const fields = (project.pydantic_fields as PydanticField[]) || [];
  const updatedFields = fields.map((field) =>
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
              ? changes.options as string[]
              : null,
          }),
        }
      : field,
  );
  return schemaSaveError(
    await saveSchemaFromGUI(projectId, updatedFields, {
      version: projectVersion(project),
      revision: project.schema_revision,
    }),
  );
}

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
  const gate = await requireCoordinator(
    projectId,
    "Apenas coordenadores podem resolver sugestões de schema.",
  );
  if (!gate.ok) return { error: gate.error };
  const user = gate.user;

  const supabase = await createSupabaseServer();

  if (action === "approved") {
    // Save schema (triggers audit log). Em falha (ex.: RLS filtrou o UPDATE
    // de projects — #178), retorna sem marcar a sugestão como aprovada,
    // evitando a divergência "Aprovada" com schema não aplicado.
    const saveError = await applyApprovedSuggestion(supabase, suggestionId, projectId);
    if (saveError) return { error: saveError };
  }

  // Mark suggestion as resolved. O .select() detecta o caso inverso ao da
  // #178: schema já aplicado mas UPDATE de schema_suggestions filtrado pela
  // RLS (0 linhas) — sem o guard, a action retornaria sucesso com a sugestão
  // ainda "pendente".
  const { data: updated, error } = await supabase
    .from("schema_suggestions")
    .update({
      status: action,
      resolved_by: user.id,
      resolved_at: new Date().toISOString(),
      ...(rejectionReason && { rejection_reason: rejectionReason }),
    })
    .eq("id", suggestionId)
    .select("id");

  if (error) return { error: error.message };
  if (!updated || updated.length === 0) {
    return {
      error:
        action === "approved"
          ? "Schema aplicado, mas sem permissão para marcar a sugestão como aprovada."
          : "Sem permissão para resolver esta sugestão.",
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
  const user = gate.user;

  // Criar o client e persistir o schema são independentes — rodam em paralelo.
  // Mesma proteção de resolveSchemaSuggestion: a sugestão só vira "approved"
  // depois que o schema persistiu de fato (o update abaixo aguarda ambos).
  const [supabase, saved] = await Promise.all([
    createSupabaseServer(),
    saveSchemaFromGUI(projectId, editedFields, expectedBaseline),
  ]);
  const saveError = schemaSaveError(saved);
  if (saveError) return { error: saveError };

  const { data: updated, error } = await supabase
    .from("schema_suggestions")
    .update({
      status: "approved",
      resolved_by: user.id,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", suggestionId)
    .select("id");

  if (error) return { error: error.message };
  if (!updated || updated.length === 0) {
    return {
      error: "Schema aplicado, mas sem permissão para marcar a sugestão como aprovada.",
    };
  }
  revalidatePath(`/projects/${projectId}/reviews/comments`);
  return {};
}
