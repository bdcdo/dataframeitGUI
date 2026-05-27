"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { getAuthUser } from "@/lib/auth";
import { syncClerkUserToSupabase } from "@/lib/clerk-sync";
import {
  retryPendingArbitrations,
  releaseArbitrationsFromUser,
} from "@/actions/field-reviews";
import { clerkClient } from "@clerk/nextjs/server";
import { revalidatePath, revalidateTag } from "next/cache";

const TAG_PROFILE = Object.freeze({ expire: 300 });

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
    // Create or reuse Clerk user, then sync to Supabase
    try {
      const clerk = await clerkClient();

      // Pre-check: o usuario pode ja existir no Clerk (ex: signup
      // anterior bloqueado pelo Cloudflare Turnstile deixa o user
      // criado mas sem profile no Supabase). Reusar evita 422
      // form_identifier_exists na chamada de createUser.
      const existing = await clerk.users.getUserList({
        emailAddress: [email],
      });

      const clerkUserId =
        existing.data.length > 0
          ? existing.data[0].id
          : (await clerk.users.createUser({ emailAddress: [email] })).id;

      userId = await syncClerkUserToSupabase(clerkUserId, email);
      invited = existing.data.length === 0;
    } catch (e) {
      // ClerkAPIResponseError tem .errors com detalhes; logar pra
      // diagnostico server-side e mostrar mensagem amigavel ao coordenador.
      console.error("[addMember] erro ao criar/sincronizar usuario Clerk", {
        email,
        error: e,
        clerkErrors: (e as { errors?: unknown })?.errors,
      });
      const msg = e instanceof Error ? e.message : "Erro desconhecido";
      return { error: `Erro ao convidar: ${msg}` };
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

// Define se um membro entra no sorteio de árbitros para casos contestados.
// Em ambos os sentidos dispara retryPendingArbitrations para realocar o
// backlog — a contagem volta em `retried` para a UI informar o coordenador.
//
// Habilita (canArbitrate=true): drena os field_reviews que estavam sem árbitro
// elegível (arbitrator_id IS NULL), sem esperar o próximo submitAutoReview.
//
// Desabilita (canArbitrate=false): primeiro solta as arbitragens não
// concluídas que estavam com esse membro (releaseArbitrationsFromUser) —
// senão ficariam presas, atribuídas a quem não pode mais arbitrar — e em
// seguida re-sorteia os casos liberados.
export async function setCanArbitrate(
  memberId: string,
  canArbitrate: boolean,
  projectId: string,
): Promise<{ error?: string; retried?: { assigned: number; stillNoPool: number } }> {
  const supabase = await createSupabaseServer();
  const { data: member, error } = await supabase
    .from("project_members")
    .update({ can_arbitrate: canArbitrate })
    .eq("id", memberId)
    .select("user_id")
    .single();

  if (error) return { error: error.message };

  if (!canArbitrate) {
    const releaseResult = await releaseArbitrationsFromUser(
      projectId,
      member.user_id,
    );
    // Falha no release deixa field_reviews atribuídos a quem não pode mais
    // arbitrar — devolve error sem chamar retry (retry filtra
    // `arbitrator_id IS NULL` e não tocaria nesses casos travados).
    if (releaseResult.error) return { error: releaseResult.error };
  }

  let retried: { assigned: number; stillNoPool: number } | undefined;
  const result = await retryPendingArbitrations(projectId);
  if (result.success) {
    retried = { assigned: result.assigned, stillNoPool: result.stillNoPool };
  }

  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/config/members`);
  revalidateTag(`project-${projectId}-members`, TAG_PROFILE);
  return { retried };
}
