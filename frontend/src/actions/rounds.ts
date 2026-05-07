"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import type { RoundStrategy } from "@/lib/types";

async function assertCoordinator(
  projectId: string,
): Promise<{ error?: string; userId?: string }> {
  const user = await getAuthUser();
  if (!user) return { error: "Não autenticado." };

  const supabase = await createSupabaseServer();
  const { data: project } = await supabase
    .from("projects")
    .select("created_by")
    .eq("id", projectId)
    .single();
  if (project?.created_by === user.id) return { userId: user.id };

  const { data: member } = await supabase
    .from("project_members")
    .select("role")
    .eq("project_id", projectId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (member?.role !== "coordenador") {
    return { error: "Apenas coordenadores podem alterar rodadas." };
  }
  return { userId: user.id };
}

export async function createRound(
  projectId: string,
  label: string,
  setAsCurrent: boolean = false,
): Promise<{ error?: string; id?: string }> {
  const trimmed = label.trim();
  if (!trimmed) return { error: "Nome da rodada é obrigatório." };

  const auth = await assertCoordinator(projectId);
  if (auth.error) return { error: auth.error };

  const supabase = await createSupabaseServer();
  const { data, error } = await supabase
    .from("rounds")
    .insert({ project_id: projectId, label: trimmed })
    .select("id")
    .single();
  if (error) return { error: error.message };

  if (setAsCurrent && data?.id) {
    const { error: updErr } = await supabase
      .from("projects")
      .update({ current_round_id: data.id })
      .eq("id", projectId);
    if (updErr) return { error: updErr.message };
  }

  revalidatePath(`/projects/${projectId}/config/rounds`);
  revalidatePath(`/projects/${projectId}/analyze/code`);
  return { id: data?.id };
}

export async function renameRound(
  projectId: string,
  roundId: string,
  label: string,
): Promise<{ error?: string }> {
  const trimmed = label.trim();
  if (!trimmed) return { error: "Nome da rodada é obrigatório." };

  const auth = await assertCoordinator(projectId);
  if (auth.error) return { error: auth.error };

  const supabase = await createSupabaseServer();
  const { error } = await supabase
    .from("rounds")
    .update({ label: trimmed })
    .eq("id", roundId)
    .eq("project_id", projectId);
  if (error) return { error: error.message };

  revalidatePath(`/projects/${projectId}/config/rounds`);
  revalidatePath(`/projects/${projectId}/analyze/code`);
  return {};
}

export async function setCurrentRound(
  projectId: string,
  roundId: string | null,
): Promise<{ error?: string }> {
  const auth = await assertCoordinator(projectId);
  if (auth.error) return { error: auth.error };

  const supabase = await createSupabaseServer();
  const { error } = await supabase
    .from("projects")
    .update({ current_round_id: roundId })
    .eq("id", projectId);
  if (error) return { error: error.message };

  revalidatePath(`/projects/${projectId}/config/rounds`);
  revalidatePath(`/projects/${projectId}/analyze/code`);
  return {};
}

export async function deleteRound(
  projectId: string,
  roundId: string,
): Promise<{ error?: string }> {
  const auth = await assertCoordinator(projectId);
  if (auth.error) return { error: auth.error };

  const supabase = await createSupabaseServer();
  const { error } = await supabase
    .from("rounds")
    .delete()
    .eq("id", roundId)
    .eq("project_id", projectId);
  if (error) return { error: error.message };

  revalidatePath(`/projects/${projectId}/config/rounds`);
  revalidatePath(`/projects/${projectId}/analyze/code`);
  return {};
}

export async function setRoundStrategy(
  projectId: string,
  strategy: RoundStrategy,
): Promise<{ error?: string }> {
  const auth = await assertCoordinator(projectId);
  if (auth.error) return { error: auth.error };

  const supabase = await createSupabaseServer();
  const { error } = await supabase
    .from("projects")
    .update({ round_strategy: strategy })
    .eq("id", projectId);
  if (error) return { error: error.message };

  revalidatePath(`/projects/${projectId}/config/rounds`);
  revalidatePath(`/projects/${projectId}/analyze/code`);
  return {};
}
