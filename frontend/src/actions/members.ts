"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { requireCoordinator } from "@/lib/auth";
import { preregisterSupabaseUser } from "@/lib/clerk-sync";
import type { MemberEmailLink, ProjectMember } from "@/lib/types";
import { retryPendingArbitrations } from "@/actions/field-reviews";
import { retryPendingComparisons } from "@/actions/comparisons";
import { revalidatePath, revalidateTag } from "next/cache";
import { after } from "next/server";
import { MEMBERS_TAG_PROFILE as TAG_PROFILE } from "@/lib/cache";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// FR-006: normaliza antes de validar; retorna null para formato inválido.
function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  return EMAIL_RE.test(email) ? email : null;
}

type ReadResult = { error?: { message: string } | null };

function firstReadError(...results: ReadResult[]): string | null {
  return results.find((result) => result.error)?.error?.message ?? null;
}

function warnAfterResponse(message: string, details: Record<string, unknown>): void {
  after(() => console.warn(message, details));
}

function schedulePendingWork(projectId: string): void {
  after(async () => {
    const [arbitrations, comparisons] = await Promise.all([
      retryPendingArbitrations(projectId),
      retryPendingComparisons(projectId),
    ]);
    if (!arbitrations.success || !comparisons.success) {
      console.warn("[members] reprocessamento pós-mudança ficou pendente", {
        projectId,
        arbitrationError: arbitrations.error,
        comparisonError: comparisons.error,
      });
    }
  });
}

async function updateMemberAttribute(
  memberId: string,
  patch: Partial<Pick<ProjectMember, "role" | "can_resolve">>,
): Promise<{ projectId: string } | { error: string }> {
  const supabase = await createSupabaseServer();
  const { data: member, error } = await supabase
    .from("project_members")
    .update(patch)
    .eq("id", memberId)
    .select("project_id")
    .maybeSingle();

  if (error) return { error: error.message };
  if (!member) return { error: "Membro não encontrado ou sem permissão." };
  return { projectId: member.project_id };
}

export async function addMember(
  projectId: string,
  rawEmail: string,
  role: "coordenador" | "pesquisador"
): Promise<{ error?: string; pending?: boolean }> {
  const gate = await requireCoordinator(
    projectId,
    "Apenas coordenadores podem adicionar membros.",
  );
  if (!gate.ok) return { error: gate.error };

  const email = normalizeEmail(rawEmail);
  if (!email) return { error: "E-mail inválido." };

  // Admin client for lookup + insert (bypasses RLS)
  const admin = createSupabaseAdmin();
  const [profileResult, linkResult] = await Promise.all([
    admin
      .from("profiles")
      .select("id, activated_at")
      .eq("email", email)
      .maybeSingle(),
    admin
      .from("member_email_links")
      .select("member_user_id")
      .eq("project_id", projectId)
      .eq("email", email)
      .maybeSingle(),
  ]);
  const lookupError = firstReadError(profileResult, linkResult);
  if (lookupError) {
    return { error: `Não foi possível verificar o e-mail: ${lookupError}` };
  }
  const profile = profileResult.data;
  const linkedTo = linkResult.data;

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
  const gate = await requireCoordinator(
    projectId,
    "Apenas coordenadores podem corrigir e-mails.",
  );
  if (!gate.ok) return { error: gate.error };

  const newEmail = normalizeEmail(rawNewEmail);
  if (!newEmail) return { error: "E-mail inválido." };

  const admin = createSupabaseAdmin();

  const [membershipResult, targetProfileResult, emailOwnerResult, emailLinkResult] =
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
    admin
      .from("member_email_links")
      .select("id")
      .eq("project_id", projectId)
      .eq("email", newEmail)
      .maybeSingle(),
    ]);
  const lookupError = firstReadError(
    membershipResult,
    targetProfileResult,
    emailOwnerResult,
    emailLinkResult,
  );
  if (lookupError) {
    return { error: `Não foi possível verificar o membro: ${lookupError}` };
  }
  const membership = membershipResult.data;
  const targetProfile = targetProfileResult.data;
  const emailOwner = emailOwnerResult.data;
  const emailLink = emailLinkResult.data;

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

export async function removeMember(memberId: string) {
  const supabase = await createSupabaseServer();
  const { data, error } = await supabase
    .rpc("remove_project_member", { p_member_id: memberId })
    .maybeSingle();

  if (error) return { error: error.message };
  const removed = data as { project_id: string } | null;
  if (!removed) return { error: "Membro não encontrado ou sem permissão." };
  const projectId = removed.project_id;

  schedulePendingWork(projectId);

  revalidatePath(`/projects/${projectId}`);
  revalidateTag(`project-${projectId}-members`, TAG_PROFILE);
}

export async function changeRole(
  memberId: string,
  role: "coordenador" | "pesquisador",
) {
  const result = await updateMemberAttribute(memberId, { role });
  if ("error" in result) return result;
  const { projectId } = result;
  revalidatePath(`/projects/${projectId}`);
  revalidateTag(`project-${projectId}-members`, TAG_PROFILE);
}

// Define se um membro pode resolver dificuldades LLM, erros LLM e comentários
// de outros pesquisadores. RLS é declarativa: habilitar/desabilitar passa a
// valer no próximo request, sem backlog a reprocessar.
export async function setCanResolve(
  memberId: string,
  canResolve: boolean,
): Promise<{ error?: string }> {
  const result = await updateMemberAttribute(memberId, {
    can_resolve: canResolve,
  });
  if ("error" in result) return result;
  const { projectId } = result;

  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/config/members`);
  revalidateTag(`project-${projectId}-members`, TAG_PROFILE);
  return {};
}

type PermissionRetry = {
  success: boolean;
  assigned: number;
  stillNoPool: number;
  error?: string;
};

type PoolPermissionResult = {
  error?: string;
  warning?: string;
  retried?: { assigned: number; stillNoPool: number };
};

async function setMemberPoolPermission(
  memberId: string,
  enabled: boolean,
  options: {
    rpc: "set_member_arbitration_permission" | "set_member_comparison_permission";
    retry: (projectId: string) => Promise<PermissionRetry>;
    warning: string;
    logMessage: string;
  },
): Promise<PoolPermissionResult> {
  const supabase = await createSupabaseServer();
  const { data, error } = await supabase
    .rpc(options.rpc, { p_member_id: memberId, p_enabled: enabled })
    .maybeSingle();

  if (error) return { error: error.message };
  const member = data as { project_id: string } | null;
  if (!member) return { error: "Membro não encontrado ou sem permissão." };

  const result = await options.retry(member.project_id);
  const retried = result.success
    ? { assigned: result.assigned, stillNoPool: result.stillNoPool }
    : undefined;
  const warning = result.success ? undefined : options.warning;
  if (!result.success) {
    warnAfterResponse(options.logMessage, {
      projectId: member.project_id,
      error: result.error,
    });
  }

  revalidatePath(`/projects/${member.project_id}`);
  revalidatePath(`/projects/${member.project_id}/config/members`);
  revalidateTag(`project-${member.project_id}-members`, TAG_PROFILE);
  return { retried, warning };
}

// Define se um membro entra no sorteio de árbitros para casos contestados.
// Em ambos os sentidos dispara retryPendingArbitrations para realocar o
// backlog — a contagem volta em `retried` para a UI informar o coordenador.
//
// Habilita (canArbitrate=true): drena os field_reviews que estavam sem árbitro
// elegível (arbitrator_id IS NULL), sem esperar o próximo submitAutoReview.
//
// Desabilita (canArbitrate=false): a RPC atualiza a permissão e solta as
// arbitragens não concluídas na mesma transação; em seguida re-sorteamos os
// casos liberados. Assim não existe janela com a permissão alterada e os casos
// ainda presos ao antigo árbitro.
export async function setCanArbitrate(
  memberId: string,
  canArbitrate: boolean,
): Promise<PoolPermissionResult> {
  return setMemberPoolPermission(memberId, canArbitrate, {
    rpc: "set_member_arbitration_permission",
    retry: retryPendingArbitrations,
    warning:
      "A permissão foi salva, mas as arbitragens pendentes não puderam ser reprocessadas.",
    logMessage: "[members] retry de arbitragens falhou após salvar permissão",
  });
}

// Define se um membro entra no sorteio de revisores de comparação
// (assignComparisonReviewer). Espelha setCanArbitrate: em ambos os sentidos
// dispara retryPendingComparisons para realocar o backlog — a contagem volta em
// `retried` para a UI informar o coordenador.
//
// Habilita: drena os documentos divergentes que estavam sem revisor elegível.
// Desabilita: a RPC atualiza a permissão e solta as comparações pendentes na
// mesma transação; em seguida re-sorteamos os casos liberados.
export async function setCanCompare(
  memberId: string,
  canCompare: boolean,
): Promise<PoolPermissionResult> {
  return setMemberPoolPermission(memberId, canCompare, {
    rpc: "set_member_comparison_permission",
    retry: retryPendingComparisons,
    warning:
      "A permissão foi salva, mas as comparações pendentes não puderam ser reprocessadas.",
    logMessage: "[members] retry de comparações falhou após salvar permissão",
  });
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
  const gate = await requireCoordinator(
    projectId,
    "Apenas coordenadores podem vincular e-mails.",
  );
  if (!gate.ok) return { error: gate.error };
  const email = normalizeEmail(rawEmail);
  if (!email) return { error: "E-mail inválido." };

  const admin = createSupabaseAdmin();

  const [targetMembershipResult, existingLinkResult, emailProfileResult] =
    await Promise.all([
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
  const initialLookupError = firstReadError(
    targetMembershipResult,
    existingLinkResult,
    emailProfileResult,
  );
  if (initialLookupError) {
    return { error: `Não foi possível verificar o vínculo: ${initialLookupError}` };
  }
  const targetMembership = targetMembershipResult.data;
  const existingLink = existingLinkResult.data;
  const emailProfile = emailProfileResult.data;

  if (!targetMembership) {
    return { error: "Membro não encontrado neste projeto." };
  }

  // Caso 1 — FR-011: 1 e-mail → 1 membro por projeto
  if (existingLink) {
    if (existingLink.member_user_id === memberUserId) {
      return { error: "Este e-mail já está vinculado a este membro." };
    }
    const { data: linkedTo, error: linkedToError } = await admin
      .from("profiles")
      .select("first_name, email")
      .eq("id", existingLink.member_user_id)
      .maybeSingle();
    if (linkedToError) {
      return { error: `Não foi possível verificar o vínculo: ${linkedToError.message}` };
    }
    const name = linkedTo?.first_name || linkedTo?.email || "outro membro";
    return { error: `Este e-mail já está vinculado a ${name} neste projeto.` };
  }

  if (emailProfile) {
    if (emailProfile.id === memberUserId) {
      return { error: "Este já é o e-mail principal deste membro." };
    }

    const { data: emailOwnerMembership, error: membershipError } = await admin
      .from("project_members")
      .select("id")
      .eq("project_id", projectId)
      .eq("user_id", emailProfile.id)
      .maybeSingle();
    if (membershipError) {
      return { error: `Não foi possível verificar o vínculo: ${membershipError.message}` };
    }

    // Caso 2 — e-mail principal de outro membro: unificação com confirmação
    // explícita (FR-009); nada é executado aqui.
    if (emailOwnerMembership) {
      const [assignmentsResult, responsesResult] = await Promise.all([
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
      const previewError = firstReadError(assignmentsResult, responsesResult);
      if (previewError) {
        return { error: `Não foi possível calcular a unificação: ${previewError}` };
      }
      const assignmentsToMigrate = assignmentsResult.count;
      const latestResponses = responsesResult.data;

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
      created_by: gate.user.id,
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
  const gate = await requireCoordinator(
    projectId,
    "Apenas coordenadores podem unificar membros.",
  );
  if (!gate.ok) return { error: gate.error };
  const admin = createSupabaseAdmin();
  const { error } = await admin.rpc("unify_project_members", {
    p_project_id: projectId,
    p_source_user_id: sourceUserId,
    p_target_user_id: targetUserId,
    p_acting_user_id: gate.user.id,
  });

  if (error) return { error: error.message };

  schedulePendingWork(projectId);

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
  const gate = await requireCoordinator(
    projectId,
    "Apenas coordenadores podem desvincular e-mails.",
  );
  if (!gate.ok) return { error: gate.error };

  const supabase = await createSupabaseServer();
  const { error } = await supabase
    .from("member_email_links")
    .delete()
    .eq("id", linkId)
    .eq("project_id", projectId);

  if (error) return { error: error.message };

  revalidatePath(`/projects/${projectId}/config/members`);
  revalidateTag(`project-${projectId}-members`, TAG_PROFILE);
  return {};
}
