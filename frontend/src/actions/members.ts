"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { getAuthUser } from "@/lib/auth";
import { preregisterSupabaseUser } from "@/lib/clerk-sync";
import {
  retryPendingArbitrations,
  releaseArbitrationsFromUser,
} from "@/actions/field-reviews";
import { revalidatePath, revalidateTag } from "next/cache";

const TAG_PROFILE = Object.freeze({ expire: 300 });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// FR-006: normaliza antes de validar; retorna null para formato inválido.
function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  return EMAIL_RE.test(email) ? email : null;
}

export async function addMember(
  projectId: string,
  rawEmail: string,
  role: "coordenador" | "pesquisador"
): Promise<{ error?: string; pending?: boolean }> {
  const user = await getAuthUser();
  if (!user) return { error: "Não autenticado." };

  const email = normalizeEmail(rawEmail);
  if (!email) return { error: "E-mail inválido." };

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
  let pending = false;

  if (profile) {
    userId = profile.id;
  } else {
    // Pré-registro (spec 002): placeholder Supabase-only, sem usuário Clerk.
    // O membro nasce pendente (activated_at = NULL) e entra de fato no
    // primeiro acesso, quando o signup real é mapeado pelo e-mail.
    try {
      userId = await preregisterSupabaseUser(email);
      pending = true;
    } catch (e) {
      console.error("[addMember] erro ao pré-registrar usuário", {
        email,
        error: e,
      });
      const msg = e instanceof Error ? e.message : "Erro desconhecido";
      return { error: `Erro ao pré-registrar: ${msg}` };
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
  return { pending };
}

// Corrige o e-mail de um membro ainda pendente (activated_at IS NULL).
// Efeito é global (FR-005): o placeholder é um só, então a correção vale para
// todos os projetos em que ele está pré-registrado — `otherProjectsCount`
// permite à UI avisar o coordenador quando há outros projetos afetados.
export async function updatePendingMemberEmail(
  projectId: string,
  memberUserId: string,
  rawNewEmail: string
): Promise<{ error?: string; otherProjectsCount?: number }> {
  const user = await getAuthUser();
  if (!user) return { error: "Não autenticado." };

  const newEmail = normalizeEmail(rawNewEmail);
  if (!newEmail) return { error: "E-mail inválido." };

  const supabase = await createSupabaseServer();
  const { data: callerMember } = await supabase
    .from("project_members")
    .select("role")
    .eq("project_id", projectId)
    .eq("user_id", user.id)
    .single();
  if (callerMember?.role !== "coordenador") {
    return { error: "Apenas coordenadores podem corrigir e-mails." };
  }

  const admin = createSupabaseAdmin();

  const [{ data: membership }, { data: targetProfile }, { data: emailOwner }] =
    await Promise.all([
      admin
        .from("project_members")
        .select("id")
        .eq("project_id", projectId)
        .eq("user_id", memberUserId)
        .maybeSingle(),
      admin
        .from("profiles")
        .select("id, activated_at")
        .eq("id", memberUserId)
        .maybeSingle(),
      admin
        .from("profiles")
        .select("id")
        .eq("email", newEmail)
        .maybeSingle(),
    ]);

  if (!membership || !targetProfile) {
    return { error: "Membro não encontrado neste projeto." };
  }
  if (targetProfile.activated_at !== null) {
    return {
      error:
        "Membro já ativou a conta — corrija via vínculo de e-mail adicional.",
    };
  }
  if (emailOwner && emailOwner.id !== memberUserId) {
    return { error: "Este e-mail já está em uso por outra conta." };
  }

  const { error: authError } = await admin.auth.admin.updateUserById(
    memberUserId,
    { email: newEmail, email_confirm: true }
  );
  if (authError) {
    return { error: `Erro ao atualizar e-mail: ${authError.message}` };
  }

  const { error: profileError } = await admin
    .from("profiles")
    .update({ email: newEmail })
    .eq("id", memberUserId);
  if (profileError) return { error: profileError.message };

  const { count } = await admin
    .from("project_members")
    .select("id", { count: "exact", head: true })
    .eq("user_id", memberUserId)
    .neq("project_id", projectId);

  revalidatePath(`/projects/${projectId}`);
  revalidateTag(`project-${projectId}-members`, TAG_PROFILE);
  return { otherProjectsCount: count ?? 0 };
}

export async function removeMember(projectId: string, memberId: string) {
  const supabase = await createSupabaseServer();
  const { data: removed, error } = await supabase
    .from("project_members")
    .delete()
    .eq("id", memberId)
    .select("user_id")
    .single();

  if (error) return { error: error.message };

  // FR-005 (research D6): atribuições nunca iniciadas voltam ao pool de
  // documentos não atribuídos. Trabalho começado (outros status) permanece.
  const admin = createSupabaseAdmin();
  const { error: assignmentsError } = await admin
    .from("assignments")
    .delete()
    .eq("project_id", projectId)
    .eq("user_id", removed.user_id)
    .eq("status", "pendente");
  if (assignmentsError) {
    console.error("[removeMember] erro ao liberar atribuições pendentes", {
      projectId,
      userId: removed.user_id,
      error: assignmentsError.message,
    });
  }

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

// Define se um membro pode resolver dificuldades LLM, erros LLM e comentários
// de outros pesquisadores. RLS é declarativa: habilitar/desabilitar passa a
// valer no próximo request, sem backlog a reprocessar.
export async function setCanResolve(
  memberId: string,
  canResolve: boolean,
  projectId: string,
): Promise<{ error?: string }> {
  const supabase = await createSupabaseServer();
  const { error } = await supabase
    .from("project_members")
    .update({ can_resolve: canResolve })
    .eq("id", memberId);

  if (error) return { error: error.message };

  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/config/members`);
  revalidateTag(`project-${projectId}-members`, TAG_PROFILE);
  return {};
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
