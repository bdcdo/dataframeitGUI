"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser, requireCoordinator } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { saveSchemaAndApproveSuggestion } from "./schema";
import type {
  PydanticField,
  SchemaBaselineIdentity,
  SchemaSnapshot,
} from "@/lib/types";
import {
  schemaSuggestionChangesSchema,
  type SchemaSuggestionChanges,
} from "@/lib/schema-suggestion";

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

// Só rejeitar: aprovar exige o schema resultante, e quem o tem é
// `approveSchemaSuggestionWithEdits` — que passa pelas RPCs de schema, onde o
// compare-and-swap por revisão e o log de auditoria vivem. Um segundo caminho de
// aprovação aqui não teria como oferecer nenhum dos dois.
export async function rejectSchemaSuggestion(
  suggestionId: string,
  projectId: string,
  rejectionReason?: string,
): Promise<{ error?: string }> {
  const gate = await requireCoordinator(
    projectId,
    "Apenas coordenadores podem resolver sugestões de schema.",
  );
  if (!gate.ok) return { error: gate.error };
  const user = gate.user;

  const supabase = await createSupabaseServer();

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
    // O filtro status='pending' zera o UPDATE tanto para sugestão inexistente
    // quanto para a já resolvida por outro coordenador (corrida normal) — a
    // copy espelha a da RPC irmã, não um falso erro de autorização.
    return {
      error: "Sugestão não encontrada ou já resolvida.",
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
): Promise<{ error?: string; conflict?: SchemaSnapshot }> {
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
  // O conflito de CAS volta tipado, com o snapshot atual: o EditFieldDialog
  // re-mescla a edição sobre ele e reenvia, em vez de descartar o trabalho do
  // coordenador com "recarregue a página" (#501).
  if (saved.status === "conflict") return { conflict: saved.current };
  if (saved.status === "error") return { error: saved.message };
  revalidatePath(`/projects/${projectId}/reviews/comments`);
  return {};
}
