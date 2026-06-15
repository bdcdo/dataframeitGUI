"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { getAuthUser, isProjectCoordinator } from "@/lib/auth";
import { preregisterSupabaseUser } from "@/lib/clerk-sync";
import type { MemberEmailLink } from "@/lib/types";
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
  const [{ data: profile }, { data: linkedTo }] = await Promise.all([
    admin
      .from("profiles")
      .select("id, activated_at")
      .eq("email", email)
      .single(),
    admin
      .from("member_email_links")
      .select("member_user_id")
      .eq("project_id", projectId)
      .eq("email", email)
      .maybeSingle(),
  ]);

  // E-mail já vinculado a um membro deste projeto: adicioná-lo como membro
  // próprio criaria uma identidade inutilizável — getEffectiveMemberId
  // resolveria a conta para o membro canônico do vínculo (caso típico:
  // e-mail de um source já unificado). Desvincular primeiro.
  if (linkedTo) {
    return {
      error:
        "Este e-mail está vinculado a outro membro do projeto. Desvincule-o antes de adicioná-lo como membro próprio.",
    };
  }

  let userId: string;
  let pending = false;

  if (profile) {
    userId = profile.id;
    // Placeholder pré-registrado em outro projeto continua pendente aqui —
    // a UI deve mostrar "pré-registrado", não "adicionado".
    pending = profile.activated_at === null;
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

  const [
    { data: membership },
    { data: targetProfile },
    { data: emailOwner },
    { data: emailLink },
  ] = await Promise.all([
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
    admin
      .from("member_email_links")
      .select("id")
      .eq("project_id", projectId)
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
  if (emailLink) {
    return { error: "Este e-mail já está vinculado a um membro do projeto." };
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
  // Vínculos de e-mail do membro no projeto saem junto (FR-012/contracts):
  // acessos futuros por alias cessam; histórico permanece.
  const admin = createSupabaseAdmin();
  const [{ error: assignmentsError }, { error: linksError }] =
    await Promise.all([
      admin
        .from("assignments")
        .delete()
        .eq("project_id", projectId)
        .eq("user_id", removed.user_id)
        .eq("status", "pendente"),
      admin
        .from("member_email_links")
        .delete()
        .eq("project_id", projectId)
        .eq("member_user_id", removed.user_id),
    ]);
  if (assignmentsError) {
    console.error("[removeMember] erro ao liberar atribuições pendentes", {
      projectId,
      userId: removed.user_id,
      error: assignmentsError.message,
    });
  }
  if (linksError) {
    console.error("[removeMember] erro ao remover vínculos de e-mail", {
      projectId,
      userId: removed.user_id,
      error: linksError.message,
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
  const { data, error } = await supabase
    .from("project_members")
    .update({ role })
    .eq("id", memberId)
    .select("id");

  if (error) return { error: error.message };
  if (!data || data.length === 0)
    return { error: "Sem permissão para alterar papéis neste projeto." };
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
  const { data, error } = await supabase
    .from("project_members")
    .update({ can_resolve: canResolve })
    .eq("id", memberId)
    .select("id");

  if (error) return { error: error.message };
  if (!data || data.length === 0)
    return { error: "Sem permissão para alterar permissões neste projeto." };

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

// Preview da unificação (FR-009): o coordenador confirma sabendo o impacto —
// quantas atribuições migram, em quantos documentos os dois membros têm
// resposta vigente (afeta comparações) e qual papel prevalece.
export interface UnificationPreview {
  sourceUserId: string;
  sourceName: string;
  targetUserId: string;
  assignmentsToMigrate: number;
  docsWithBothResponses: number;
  resultingRole: "coordenador" | "pesquisador";
}

// Vincula um e-mail adicional a um membro (US2). Casos do contrato, na ordem:
// 1. e-mail já vinculado no projeto → erro; 2. e-mail é o principal de outro
// membro → retorna requiresUnification (não executa nada); 3. conta existente
// não-membro → link com linked_user_id; 4. sem conta → link pendente
// (linked_user_id NULL, vale como pré-registro do e-mail — clarificação Q2).
export async function linkMemberEmail(
  projectId: string,
  memberUserId: string,
  rawEmail: string
): Promise<{
  link?: MemberEmailLink;
  requiresUnification?: UnificationPreview;
  error?: string;
}> {
  const user = await getAuthUser();
  if (!user) return { error: "Não autenticado." };
  if (!(await isProjectCoordinator(projectId, user))) {
    return { error: "Apenas coordenadores podem vincular e-mails." };
  }

  const email = normalizeEmail(rawEmail);
  if (!email) return { error: "E-mail inválido." };

  const admin = createSupabaseAdmin();

  const [
    { data: targetMembership },
    { data: existingLink },
    { data: emailProfile },
  ] = await Promise.all([
    admin
      .from("project_members")
      .select("role")
      .eq("project_id", projectId)
      .eq("user_id", memberUserId)
      .maybeSingle(),
    admin
      .from("member_email_links")
      .select("id, member_user_id")
      .eq("project_id", projectId)
      .eq("email", email)
      .maybeSingle(),
    admin
      .from("profiles")
      .select("id, first_name, email")
      .eq("email", email)
      .maybeSingle(),
  ]);

  if (!targetMembership) {
    return { error: "Membro não encontrado neste projeto." };
  }

  // Caso 1 — FR-011: 1 e-mail → 1 membro por projeto
  if (existingLink) {
    if (existingLink.member_user_id === memberUserId) {
      return { error: "Este e-mail já está vinculado a este membro." };
    }
    const { data: linkedTo } = await admin
      .from("profiles")
      .select("first_name, email")
      .eq("id", existingLink.member_user_id)
      .maybeSingle();
    const name = linkedTo?.first_name || linkedTo?.email || "outro membro";
    return { error: `Este e-mail já está vinculado a ${name} neste projeto.` };
  }

  if (emailProfile) {
    if (emailProfile.id === memberUserId) {
      return { error: "Este já é o e-mail principal deste membro." };
    }

    const { data: emailOwnerMembership } = await admin
      .from("project_members")
      .select("id")
      .eq("project_id", projectId)
      .eq("user_id", emailProfile.id)
      .maybeSingle();

    // Caso 2 — e-mail principal de outro membro: unificação com confirmação
    // explícita (FR-009); nada é executado aqui.
    if (emailOwnerMembership) {
      const [{ count: assignmentsToMigrate }, { data: latestResponses }] =
        await Promise.all([
          admin
            .from("assignments")
            .select("id", { count: "exact", head: true })
            .eq("project_id", projectId)
            .eq("user_id", emailProfile.id),
          admin
            .from("responses")
            .select("document_id, respondent_id")
            .eq("project_id", projectId)
            .eq("respondent_type", "humano")
            .eq("is_latest", true)
            .in("respondent_id", [emailProfile.id, memberUserId]),
        ]);

      const docsBySource = new Set(
        (latestResponses || [])
          .filter((r) => r.respondent_id === emailProfile.id)
          .map((r) => r.document_id),
      );
      const docsWithBothResponses = (latestResponses || []).filter(
        (r) =>
          r.respondent_id === memberUserId && docsBySource.has(r.document_id),
      ).length;

      return {
        requiresUnification: {
          sourceUserId: emailProfile.id,
          sourceName: emailProfile.first_name || emailProfile.email || "membro",
          targetUserId: memberUserId,
          assignmentsToMigrate: assignmentsToMigrate ?? 0,
          docsWithBothResponses,
          resultingRole: targetMembership.role as "coordenador" | "pesquisador",
        },
      };
    }
  }

  // Casos 3 e 4 — insert do vínculo (alias imediato ou pendente de conta)
  const { data: link, error } = await admin
    .from("member_email_links")
    .insert({
      project_id: projectId,
      member_user_id: memberUserId,
      email,
      linked_user_id: emailProfile?.id ?? null,
      created_by: user.id,
    })
    .select(
      "id, project_id, member_user_id, email, linked_user_id, created_by, created_at",
    )
    .single();

  if (error) {
    if (error.code === "23505") {
      return { error: "Este e-mail já está vinculado a um membro do projeto." };
    }
    return { error: error.message };
  }

  revalidatePath(`/projects/${projectId}/config/members`);
  revalidateTag(`project-${projectId}-members`, TAG_PROFILE);
  return { link: link as MemberEmailLink };
}

// Executa a unificação após confirmação explícita no dialog (FR-009).
// Permanente (clarificação Q1) — a RPC migra identidade de trabalho do source
// para o target no escopo do projeto e registra o alias.
export async function unifyMembers(
  projectId: string,
  sourceUserId: string,
  targetUserId: string
): Promise<{ error?: string }> {
  const user = await getAuthUser();
  if (!user) return { error: "Não autenticado." };
  if (!(await isProjectCoordinator(projectId, user))) {
    return { error: "Apenas coordenadores podem unificar membros." };
  }

  const admin = createSupabaseAdmin();
  const { error } = await admin.rpc("unify_project_members", {
    p_project_id: projectId,
    p_source_user_id: sourceUserId,
    p_target_user_id: targetUserId,
    p_acting_user_id: user.id,
  });

  if (error) return { error: error.message };

  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/config/members`);
  revalidatePath(`/projects/${projectId}/analyze/assignments`);
  revalidatePath(`/projects/${projectId}/analyze/compare`);
  revalidateTag(`project-${projectId}-members`, TAG_PROFILE);
  return {};
}

// Desvincula um e-mail (FR-012): acessos futuros pelo e-mail cessam; o
// histórico permanece (nada referencia a linha). Não desfaz unificação.
export async function unlinkMemberEmail(
  projectId: string,
  linkId: string
): Promise<{ error?: string }> {
  const user = await getAuthUser();
  if (!user) return { error: "Não autenticado." };
  if (!(await isProjectCoordinator(projectId, user))) {
    return { error: "Apenas coordenadores podem desvincular e-mails." };
  }

  const admin = createSupabaseAdmin();
  const { error } = await admin
    .from("member_email_links")
    .delete()
    .eq("id", linkId)
    .eq("project_id", projectId);

  if (error) return { error: error.message };

  revalidatePath(`/projects/${projectId}/config/members`);
  revalidateTag(`project-${projectId}-members`, TAG_PROFILE);
  return {};
}
