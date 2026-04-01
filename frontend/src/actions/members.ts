"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { getAuthUser } from "@/lib/auth";
import { syncClerkUserToSupabase } from "@/lib/clerk-sync";
import { clerkClient } from "@clerk/nextjs/server";
import { revalidatePath, revalidateTag } from "next/cache";

const TAG_PROFILE = { expire: 300 };

export async function addMember(
  projectId: string,
  email: string,
  role: "coordenador" | "pesquisador"
): Promise<{ error?: string; invited?: boolean }> {
  const user = await getAuthUser();
  if (!user) return { error: "Não autenticado." };

  const supabase = await createSupabaseServer();

  // Verify caller is coordinator (via normal client, RLS applies)
  const { data: callerMember } = await supabase
    .from("project_members")
    .select("role")
    .eq("project_id", projectId)
    .eq("user_id", user.id)
    .single();
  if (callerMember?.role !== "coordenador") {
    return { error: "Apenas coordenadores podem adicionar membros." };
  }

  // Admin client for lookup + insert (bypasses RLS)
  const admin = createSupabaseAdmin();
  const { data: profile } = await admin
    .from("profiles")
    .select("id")
    .eq("email", email)
    .single();

  let userId: string;
  let invited = false;

  if (profile) {
    userId = profile.id;
  } else {
    // Create user in Clerk and sync to Supabase
    try {
      const clerk = await clerkClient();
      const clerkUser = await clerk.users.createUser({
        emailAddress: [email],
      });
      userId = await syncClerkUserToSupabase(
        clerkUser.id,
        email,
      );
      invited = true;
    } catch (e) {
      return { error: `Erro ao convidar: ${e instanceof Error ? e.message : "Erro desconhecido"}` };
    }
  }

  const { error } = await admin.from("project_members").insert({
    project_id: projectId,
    user_id: userId,
    role,
  });

  if (error) {
    if (error.code === "23505") {
      return { error: "Usuário já é membro deste projeto." };
    }
    return { error: error.message };
  }

  revalidatePath(`/projects/${projectId}`);
  revalidateTag(`project-${projectId}-members`, TAG_PROFILE);
  return { invited };
}

export async function removeMember(projectId: string, memberId: string) {
  const supabase = await createSupabaseServer();
  const { error } = await supabase
    .from("project_members")
    .delete()
    .eq("id", memberId);

  if (error) return { error: error.message };
  revalidatePath(`/projects/${projectId}`);
  revalidateTag(`project-${projectId}-members`, TAG_PROFILE);
}

export async function changeRole(
  memberId: string,
  role: "coordenador" | "pesquisador",
  projectId: string
) {
  const supabase = await createSupabaseServer();
  const { error } = await supabase
    .from("project_members")
    .update({ role })
    .eq("id", memberId);

  if (error) return { error: error.message };
  revalidatePath(`/projects/${projectId}`);
  revalidateTag(`project-${projectId}-members`, TAG_PROFILE);
}
