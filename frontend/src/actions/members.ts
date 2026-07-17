"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { requireCoordinator } from "@/lib/auth";
import {
  ClerkIdentityConflictError,
  preregisterSupabaseUser,
  reconcileVerifiedClerkEmailOwner,
} from "@/lib/clerk-sync";
import type { MemberEmailLink } from "@/lib/types";
import { retryPendingArbitrations } from "@/actions/field-reviews";
import { retryPendingComparisons } from "@/actions/comparisons";
import { revalidatePath, revalidateTag } from "next/cache";
import { MEMBERS_TAG_PROFILE as TAG_PROFILE } from "@/lib/cache";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// FR-006: normaliza antes de validar; retorna null para formato inválido.
function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  return EMAIL_RE.test(email) ? email : null;
}

type MemberAdminClient = ReturnType<typeof createSupabaseAdmin>;
type MemberIdentityOperation = "addMember" | "linkMemberEmail" | "unifyMembers";

interface EmailProfile {
  id: string;
  first_name: string | null;
  email: string;
  activated_at: string | null;
}

type ProfileIdentityState = "active" | "claimable" | "mapped";

async function classifyProfileIdentity(
  admin: MemberAdminClient,
  profile: Pick<EmailProfile, "id" | "activated_at">,
): Promise<
  | { status: "classified"; state: ProfileIdentityState }
  | { status: "error"; error: string }
> {
  if (profile.activated_at !== null) {
    return { status: "classified", state: "active" };
  }

  const { data, error } = await admin
    .from("clerk_user_mapping")
    .select("supabase_user_id")
    .eq("supabase_user_id", profile.id)
    .maybeSingle();
  if (error) return { status: "error", error: error.message };
  return { status: "classified", state: data ? "mapped" : "claimable" };
}

interface MemberIdentityLogContext {
  projectId: string;
  email: string;
  memberUserId?: string;
  sourceUserId?: string;
  targetUserId?: string;
}

type ClerkEmailOwnerResolution =
  | { status: "resolved"; userId: string; snapshotVersion: number }
  | { status: "unowned" }
  | { status: "error"; error: string };

async function resolveVerifiedClerkEmailOwner(
  operation: MemberIdentityOperation,
  context: MemberIdentityLogContext,
): Promise<ClerkEmailOwnerResolution> {
  try {
    const owner = await reconcileVerifiedClerkEmailOwner(context.email);
    return owner.status === "changed"
      ? {
          status: "error",
          error: "A posse verificada do e-mail mudou. Tente novamente.",
        }
      : owner;
  } catch (error) {
    console.error(`[${operation}] Clerk ownership reconciliation failed`, {
      ...context,
      error,
    });
    // Conflito estrutural não melhora com insistência: devolver "tente
    // novamente" deixaria o coordenador repetindo um vínculo que nunca vai
    // completar. A mensagem própria do erro descreve o que está no caminho.
    if (error instanceof ClerkIdentityConflictError) {
      return { status: "error", error: error.message };
    }
    return {
      status: "error",
      error:
        "Não foi possível verificar a posse atual do e-mail. Tente novamente.",
    };
  }
}

type AddMemberIdentityResult =
  | {
      status: "resolved";
      userId: string;
      pending: boolean;
      expectedSnapshotVersion: number | null;
    }
  | { status: "error"; error: string };

async function resolveCurrentClerkMemberIdentity(
  admin: MemberAdminClient,
  projectId: string,
  ownerUserId: string,
  expectedSnapshotVersion: number,
): Promise<AddMemberIdentityResult> {
  const [profileResult, membershipResult, linkResult] = await Promise.all([
    admin.from("profiles").select("id").eq("id", ownerUserId).maybeSingle(),
    admin
      .from("project_members")
      .select("id")
      .eq("project_id", projectId)
      .eq("user_id", ownerUserId)
      .maybeSingle(),
    admin
      .from("member_email_links")
      .select("member_user_id")
      .eq("project_id", projectId)
      .eq("linked_user_id", ownerUserId)
      .limit(1)
      .maybeSingle(),
  ]);
  const error =
    profileResult.error ?? membershipResult.error ?? linkResult.error;
  if (error) return { status: "error", error: error.message };
  if (!profileResult.data) {
    return {
      status: "error",
      error: "A conta verificada não possui profile Supabase.",
    };
  }
  if (membershipResult.data) {
    return { status: "error", error: "Usuário já é membro deste projeto." };
  }
  if (linkResult.data) {
    return {
      status: "error",
      error:
        "Esta conta já está vinculada a um membro do projeto. Desvincule-a antes de adicioná-la como membro próprio.",
    };
  }
  return {
    status: "resolved",
    userId: ownerUserId,
    pending: false,
    expectedSnapshotVersion,
  };
}

async function resolvePendingMemberIdentity(
  email: string,
  emailProfile: { id: string; activated_at: string | null } | null,
): Promise<AddMemberIdentityResult> {
  if (emailProfile?.activated_at === null) {
    return {
      status: "resolved",
      userId: emailProfile.id,
      pending: true,
      expectedSnapshotVersion: null,
    };
  }
  if (emailProfile) {
    return {
      status: "error",
      error:
        "Não foi possível confirmar que a conta ativa ainda possui este e-mail.",
    };
  }

  try {
    return {
      status: "resolved",
      userId: await preregisterSupabaseUser(email),
      pending: true,
      expectedSnapshotVersion: null,
    };
  } catch (error) {
    console.error("[addMember] erro ao pré-registrar usuário", {
      email,
      error,
    });
    const message =
      error instanceof Error ? error.message : "Erro desconhecido";
    return { status: "error", error: `Erro ao pré-registrar: ${message}` };
  }
}

type AddMemberLocalState =
  | {
      status: "loaded";
      emailProfile: { id: string; activated_at: string | null } | null;
      mappedPendingUserId: string | null;
    }
  | { status: "error"; error: string };

async function classifyPendingAddMemberProfile(
  admin: MemberAdminClient,
  projectId: string,
  emailProfile: { id: string; activated_at: null },
): Promise<AddMemberLocalState> {
  const [membershipResult, identityState] = await Promise.all([
    admin
      .from("project_members")
      .select("id")
      .eq("project_id", projectId)
      .eq("user_id", emailProfile.id)
      .maybeSingle(),
    classifyProfileIdentity(admin, emailProfile),
  ]);
  if (membershipResult.error) {
    return { status: "error", error: membershipResult.error.message };
  }
  if (identityState.status === "error") return identityState;
  if (membershipResult.data) {
    return { status: "error", error: "Usuário já é membro deste projeto." };
  }
  return {
    status: "loaded",
    emailProfile,
    mappedPendingUserId:
      identityState.state === "mapped" ? emailProfile.id : null,
  };
}

async function loadAddMemberLocalState(
  admin: MemberAdminClient,
  projectId: string,
  email: string,
): Promise<AddMemberLocalState> {
  const [emailProfileResult, linkedToResult] = await Promise.all([
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
  const lookupError = emailProfileResult.error ?? linkedToResult.error;
  if (lookupError) return { status: "error", error: lookupError.message };
  if (linkedToResult.data) {
    return {
      status: "error",
      error:
        "Este e-mail está vinculado a outro membro do projeto. Desvincule-o antes de adicioná-lo como membro próprio.",
    };
  }

  const emailProfile = emailProfileResult.data;
  // Somente o placeholder pendente representa autoridade local sobre o e-mail.
  // Um profile ativo pode conservar um endereço histórico; nesse caso o Clerk
  // decide o dono atual antes de verificarmos a membership do UID reconciliado.
  if (emailProfile?.activated_at === null) {
    return classifyPendingAddMemberProfile(admin, projectId, emailProfile);
  }

  return { status: "loaded", emailProfile, mappedPendingUserId: null };
}

export async function addMember(
  projectId: string,
  rawEmail: string,
  role: "coordenador" | "pesquisador",
): Promise<{ error?: string; pending?: boolean }> {
  const gate = await requireCoordinator(
    projectId,
    "Apenas coordenadores podem adicionar membros.",
  );
  if (!gate.ok) return { error: gate.error };

  const email = normalizeEmail(rawEmail);
  if (!email) return { error: "E-mail inválido." };

  const admin = createSupabaseAdmin();
  const localState = await loadAddMemberLocalState(admin, projectId, email);
  if (localState.status === "error") return { error: localState.error };

  const owner = await resolveVerifiedClerkEmailOwner("addMember", {
    projectId,
    email,
  });
  if (owner.status === "error") return { error: owner.error };
  if (
    localState.mappedPendingUserId &&
    (owner.status !== "resolved" ||
      owner.userId !== localState.mappedPendingUserId)
  ) {
    return {
      error:
        "Este pré-registro já pertence a outra conta Clerk e não pode ser reutilizado.",
    };
  }

  const identity =
    owner.status === "resolved"
      ? await resolveCurrentClerkMemberIdentity(
          admin,
          projectId,
          owner.userId,
          owner.snapshotVersion,
        )
      : await resolvePendingMemberIdentity(email, localState.emailProfile);
  if (identity.status === "error") return { error: identity.error };

  const { error } = await admin.rpc("add_project_member_with_identity_proof", {
    p_project_id: projectId,
    p_user_id: identity.userId,
    p_role: role,
    p_email: email,
    p_expected_snapshot_version: identity.expectedSnapshotVersion,
  });

  if (error) {
    if (error.code === "23505") {
      return { error: "Usuário já é membro deste projeto." };
    }
    if (error.code === "40001") {
      return { error: "A posse verificada do e-mail mudou. Tente novamente." };
    }
    return { error: error.message };
  }

  revalidatePath(`/projects/${projectId}`);
  revalidateTag(`project-${projectId}-members`, TAG_PROFILE);
  return { pending: identity.pending };
}

// Corrige o e-mail de um membro ainda pendente (activated_at IS NULL).
// Efeito é global (FR-005): o placeholder é um só, então a correção vale para
// todos os projetos em que ele está pré-registrado — `otherProjectsCount`
// permite à UI avisar o coordenador quando há outros projetos afetados.
export async function updatePendingMemberEmail(
  projectId: string,
  memberUserId: string,
  rawNewEmail: string,
): Promise<{ error?: string; otherProjectsCount?: number }> {
  const gate = await requireCoordinator(
    projectId,
    "Apenas coordenadores podem corrigir e-mails.",
  );
  if (!gate.ok) return { error: gate.error };

  const newEmail = normalizeEmail(rawNewEmail);
  if (!newEmail) return { error: "E-mail inválido." };

  const admin = createSupabaseAdmin();

  const [
    membershipResult,
    targetProfileResult,
    emailOwnerResult,
    emailLinkResult,
    resolvedAliasResult,
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
    admin.from("profiles").select("id").eq("email", newEmail).maybeSingle(),
    admin
      .from("member_email_links")
      .select("id")
      .eq("project_id", projectId)
      .eq("email", newEmail)
      .maybeSingle(),
    admin
      .from("member_email_links")
      .select("id")
      .eq("project_id", projectId)
      .eq("member_user_id", memberUserId)
      .not("linked_user_id", "is", null)
      .limit(1)
      .maybeSingle(),
  ]);
  const lookupError =
    membershipResult.error ??
    targetProfileResult.error ??
    emailOwnerResult.error ??
    emailLinkResult.error ??
    resolvedAliasResult.error;
  if (lookupError) return { error: lookupError.message };
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
  // Membro trabalhado via alias resolvido não é placeholder livre: repontar o
  // e-mail dele deixaria uma segunda pessoa reivindicar a MESMA identidade
  // canônica enquanto o alias continua resolvendo para a primeira. Mesmo
  // critério da affordance na UI (canEditPendingMemberEmail).
  if (resolvedAliasResult.data) {
    return {
      error:
        "Este membro já trabalha via vínculo de e-mail resolvido e não pode ter o e-mail de pré-registro alterado.",
    };
  }

  const identityState = await classifyProfileIdentity(admin, {
    id: memberUserId,
    activated_at: targetProfile.activated_at,
  });
  if (identityState.status === "error") return { error: identityState.error };
  if (identityState.state !== "claimable") {
    return {
      error:
        "Este membro já está vinculado a uma conta Clerk e não pode ter o e-mail de pré-registro alterado.",
    };
  }

  // O trigger de auth.users serializa esta correção com claims Clerk, revalida
  // que o profile continua pendente e sem mapping e atualiza profiles.email na
  // mesma transação; uma segunda escrita manual abriria estado parcial.
  const { error: authError } = await admin.auth.admin.updateUserById(
    memberUserId,
    { email: newEmail, email_confirm: true },
  );
  if (authError) {
    return { error: `Erro ao atualizar e-mail: ${authError.message}` };
  }

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

  revalidatePath(`/projects/${projectId}`);
  revalidateTag(`project-${projectId}-members`, TAG_PROFILE);
}

export async function changeRole(
  memberId: string,
  role: "coordenador" | "pesquisador",
) {
  const supabase = await createSupabaseServer();
  const { data: member, error } = await supabase
    .from("project_members")
    .update({ role })
    .eq("id", memberId)
    .select("project_id")
    .maybeSingle();

  if (error) return { error: error.message };
  if (!member) return { error: "Membro não encontrado ou sem permissão." };
  const projectId = member.project_id;
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
  const supabase = await createSupabaseServer();
  const { data: member, error } = await supabase
    .from("project_members")
    .update({ can_resolve: canResolve })
    .eq("id", memberId)
    .select("project_id")
    .maybeSingle();

  if (error) return { error: error.message };
  if (!member) return { error: "Membro não encontrado ou sem permissão." };
  const projectId = member.project_id;

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
// Desabilita (canArbitrate=false): a RPC atualiza a permissão e solta as
// arbitragens não concluídas na mesma transação; em seguida re-sorteamos os
// casos liberados. Assim não existe janela com a permissão alterada e os casos
// ainda presos ao antigo árbitro.
export async function setCanArbitrate(
  memberId: string,
  canArbitrate: boolean,
): Promise<{
  error?: string;
  retried?: { assigned: number; stillNoPool: number };
}> {
  const supabase = await createSupabaseServer();
  const { data, error } = await supabase
    .rpc("set_member_arbitration_permission", {
      p_member_id: memberId,
      p_enabled: canArbitrate,
    })
    .maybeSingle();

  if (error) return { error: error.message };
  const member = data as { project_id: string } | null;
  if (!member) return { error: "Membro não encontrado ou sem permissão." };
  const projectId = member.project_id;

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
): Promise<{
  error?: string;
  retried?: { assigned: number; stillNoPool: number };
}> {
  const supabase = await createSupabaseServer();
  const { data, error } = await supabase
    .rpc("set_member_comparison_permission", {
      p_member_id: memberId,
      p_enabled: canCompare,
    })
    .maybeSingle();

  if (error) return { error: error.message };
  const member = data as { project_id: string } | null;
  if (!member) return { error: "Membro não encontrado ou sem permissão." };
  const projectId = member.project_id;

  let retried: { assigned: number; stillNoPool: number } | undefined;
  const result = await retryPendingComparisons(projectId);
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
  reviewConflicts: number;
  arbitrationConflicts: number;
  comparisonConflicts: number;
  resultingRole: "coordenador" | "pesquisador";
  linkEmail: string;
}

interface MemberEmailLinkContext {
  targetMembership: { role: "coordenador" | "pesquisador" };
  existingLink: MemberEmailLink | null;
  emailProfile: EmailProfile | null;
  emailProfileState: ProfileIdentityState | null;
}

type MemberEmailLinkWriteResult =
  | {
      status: "linked";
      link: MemberEmailLink;
      access: "ready" | "pending";
    }
  | { status: "error"; error: string };

type LinkMemberEmailResult =
  | MemberEmailLinkWriteResult
  | { status: "requires-unification"; preview: UnificationPreview };

interface ResolvedLinkOwnership {
  context: MemberEmailLinkContext;
  ownerProfile: EmailProfile | null;
  ownerSnapshotVersion: number | null;
}

type MemberEmailLinkContextResult =
  | { status: "loaded"; data: MemberEmailLinkContext }
  | { status: "error"; error: string };

// A estimativa de CRAP não enxerga os ramos exercitados via linkMemberEmail;
// manter a validação do mesmo snapshot aqui evita espalhá-la em helpers únicos.
// fallow-ignore-next-line complexity
async function loadMemberEmailLinkContext(
  admin: MemberAdminClient,
  projectId: string,
  memberUserId: string,
  email: string,
): Promise<MemberEmailLinkContextResult> {
  const [membershipResult, linkResult, profileResult] = await Promise.all([
    admin
      .from("project_members")
      .select("role")
      .eq("project_id", projectId)
      .eq("user_id", memberUserId)
      .maybeSingle(),
    admin
      .from("member_email_links")
      .select(
        "id, project_id, member_user_id, email, linked_user_id, created_by, created_at",
      )
      .eq("project_id", projectId)
      .eq("email", email)
      .maybeSingle(),
    admin
      .from("profiles")
      .select("id, first_name, email, activated_at")
      .eq("email", email)
      .maybeSingle(),
  ]);
  const error =
    membershipResult.error ?? linkResult.error ?? profileResult.error;
  if (error) return { status: "error", error: error.message };

  const targetMembership = membershipResult.data;
  const existingLink = linkResult.data;
  if (!targetMembership) {
    return { status: "error", error: "Membro não encontrado neste projeto." };
  }
  if (existingLink && existingLink.member_user_id !== memberUserId) {
    const { data: linkedTo, error: profileError } = await admin
      .from("profiles")
      .select("first_name, email")
      .eq("id", existingLink.member_user_id)
      .maybeSingle();
    if (profileError) return { status: "error", error: profileError.message };
    const name = linkedTo?.first_name || linkedTo?.email || "outro membro";
    return {
      status: "error",
      error: `Este e-mail já está vinculado a ${name} neste projeto.`,
    };
  }

  const emailProfile = profileResult.data as EmailProfile | null;
  const identityState = emailProfile
    ? await classifyProfileIdentity(admin, emailProfile)
    : null;
  if (identityState?.status === "error") return identityState;

  return {
    status: "loaded",
    data: {
      targetMembership:
        targetMembership as MemberEmailLinkContext["targetMembership"],
      existingLink: existingLink as MemberEmailLink | null,
      emailProfile,
      emailProfileState: identityState?.state ?? null,
    },
  };
}

async function loadCurrentEmailOwnerProfile(
  admin: MemberAdminClient,
  ownerUserId: string,
): Promise<
  | { status: "loaded"; profile: EmailProfile }
  | { status: "error"; error: string }
> {
  const { data, error } = await admin
    .from("profiles")
    .select("id, first_name, email, activated_at")
    .eq("id", ownerUserId)
    .maybeSingle();
  if (error) return { status: "error", error: error.message };
  if (!data) {
    return {
      status: "error",
      error: "A conta verificada não possui profile Supabase.",
    };
  }
  return { status: "loaded", profile: data as EmailProfile };
}

interface LinkOwnershipRequest {
  projectId: string;
  memberUserId: string;
  email: string;
}

async function resolveLinkOwnership(
  admin: MemberAdminClient,
  request: LinkOwnershipRequest,
  initialContext: MemberEmailLinkContext,
  owner: { userId: string; snapshotVersion: number } | null,
): Promise<
  | { status: "resolved"; data: ResolvedLinkOwnership }
  | { status: "error"; error: string }
> {
  if (!owner) {
    return {
      status: "resolved",
      data: {
        context: initialContext,
        ownerProfile: null,
        ownerSnapshotVersion: null,
      },
    };
  }

  const ownerProfile = await loadCurrentEmailOwnerProfile(admin, owner.userId);
  if (ownerProfile.status === "error") return ownerProfile;

  // A reconciliação pode convergir o próprio vínculo. A decisão precisa usar
  // um snapshot posterior, não as linhas lidas antes da mutação de identidade.
  const current = await loadMemberEmailLinkContext(
    admin,
    request.projectId,
    request.memberUserId,
    request.email,
  );
  if (current.status === "error") return current;
  return {
    status: "resolved",
    data: {
      context: current.data,
      ownerProfile: ownerProfile.profile,
      ownerSnapshotVersion: owner.snapshotVersion,
    },
  };
}

async function buildUnificationPreview(
  admin: MemberAdminClient,
  projectId: string,
  source: EmailProfile,
  targetUserId: string,
  resultingRole: "coordenador" | "pesquisador",
  linkEmail: string,
): Promise<{ data: UnificationPreview | null } | { error: string }> {
  const { data, error } = await admin
    .rpc("preview_project_member_unification", {
      p_project_id: projectId,
      p_source_user_id: source.id,
      p_target_user_id: targetUserId,
    })
    .maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { data: null };

  const preview = data as {
    assignments_to_migrate: number;
    docs_with_both_responses: number;
    review_conflicts: number;
    arbitration_conflicts: number;
    comparison_conflicts: number;
  };

  return {
    data: {
      sourceUserId: source.id,
      sourceName: source.first_name || source.email || "membro",
      targetUserId,
      assignmentsToMigrate: preview.assignments_to_migrate,
      docsWithBothResponses: preview.docs_with_both_responses,
      reviewConflicts: preview.review_conflicts,
      arbitrationConflicts: preview.arbitration_conflicts,
      comparisonConflicts: preview.comparison_conflicts,
      resultingRole,
      linkEmail,
    },
  };
}

type LinkUnificationDecision =
  | { status: "continue"; emailProfile: EmailProfile | null }
  | { status: "requires-unification"; preview: UnificationPreview }
  | { status: "error"; error: string };

interface LinkUnificationContext {
  projectId: string;
  memberUserId: string;
  linkEmail: string;
  targetRole: "coordenador" | "pesquisador";
  emailProfile: EmailProfile | null;
  emailProfileState: ProfileIdentityState | null;
  ownerProfile: EmailProfile | null;
}

function collectUnificationCandidates(
  memberUserId: string,
  emailProfile: EmailProfile | null,
  emailProfileState: ProfileIdentityState | null,
  ownerProfile: EmailProfile | null,
): EmailProfile[] {
  const candidates = new Map<string, EmailProfile>();
  if (ownerProfile) candidates.set(ownerProfile.id, ownerProfile);
  if (
    emailProfile &&
    ((!ownerProfile && emailProfileState === "active") ||
      emailProfileState === "claimable")
  ) {
    candidates.set(emailProfile.id, emailProfile);
  }
  candidates.delete(memberUserId);
  return [...candidates.values()];
}

async function loadUnificationPreviews(
  admin: MemberAdminClient,
  context: LinkUnificationContext,
  candidates: EmailProfile[],
): Promise<{ data: UnificationPreview[] } | { error: string }> {
  const results = await Promise.all(
    candidates.map((source) =>
      buildUnificationPreview(
        admin,
        context.projectId,
        source,
        context.memberUserId,
        context.targetRole,
        context.linkEmail,
      ),
    ),
  );
  const failed = results.find(
    (result): result is { error: string } => "error" in result,
  );
  if (failed) return failed;

  return {
    data: results.flatMap((result) =>
      "data" in result && result.data ? [result.data] : [],
    ),
  };
}

// A função classifica uma única decisão de domínio e seus ramos são cobertos
// pela action pública; separá-los criaria helpers de uso único sem novo contrato.
// fallow-ignore-next-line complexity
async function decideLinkUnification(
  admin: MemberAdminClient,
  context: LinkUnificationContext,
): Promise<LinkUnificationDecision> {
  const { memberUserId, emailProfile, emailProfileState, ownerProfile } =
    context;
  // O profile encontrado por `profiles.email` pode ser um dono histórico do
  // endereço. Quando o Clerk confirma outro dono atual, somente esse dono e um
  // eventual placeholder ainda pendente são fontes legítimas de trabalho.
  const candidates = collectUnificationCandidates(
    memberUserId,
    emailProfile,
    emailProfileState,
    ownerProfile,
  );
  const loaded = await loadUnificationPreviews(admin, context, candidates);
  if ("error" in loaded) return { status: "error", error: loaded.error };
  const previews = loaded.data;
  if (!ownerProfile && emailProfile?.activated_at && previews.length > 0) {
    return {
      status: "error",
      error:
        "O e-mail pertence a um membro ativo, mas sua posse atual não pôde ser confirmada no Clerk.",
    };
  }
  if (previews.length > 1) {
    return {
      status: "error",
      error:
        "O e-mail envolve mais de uma identidade existente no projeto; resolva-as separadamente.",
    };
  }
  if (previews[0]) {
    return { status: "requires-unification", preview: previews[0] };
  }

  return {
    status: "continue",
    // Um profile ativo sem posse Clerk atual não pode receber o vínculo; sem
    // membership a linha permanece como pré-registro do endereço.
    emailProfile:
      !ownerProfile && emailProfile?.activated_at ? null : emailProfile,
  };
}

interface MemberEmailLinkWriteContext {
  projectId: string;
  memberUserId: string;
  email: string;
  linkedUserId: string | null;
  createdBy: string;
  access: "ready" | "pending";
  existingLink: MemberEmailLink | null;
  expectedSnapshotVersion: number | null;
}

const MEMBER_EMAIL_LINK_WRITE_ERRORS: Readonly<Record<string, string>> = {
  "23505": "Este e-mail já está vinculado a um membro do projeto.",
  "40001": "A posse verificada do e-mail mudou. Tente novamente.",
  "23514":
    "A identidade do vínculo mudou. Tente novamente para revisar a unificação.",
  // As RPCs de vínculo sinalizam com 22023 os argumentos que não descrevem uma
  // identidade utilizável (e-mail vazio, prova de snapshot sem conta ligada).
  // Sem esta entrada o fallback abaixo mostra a mensagem interna da função, que
  // fala de snapshot e Clerk — vocabulário que a tela não deve expor.
  "22023":
    "Não foi possível confirmar a conta deste e-mail. Verifique o endereço e tente de novo.",
};

function memberEmailLinkWriteError(
  error: { code?: string; message: string } | null,
): string | null {
  if (!error) return null;
  return MEMBER_EMAIL_LINK_WRITE_ERRORS[error.code ?? ""] ?? error.message;
}

async function persistMemberEmailLink(
  admin: MemberAdminClient,
  context: MemberEmailLinkWriteContext,
): Promise<MemberEmailLinkWriteResult> {
  const existing = context.existingLink;
  const { data, error } = await admin
    .rpc("write_member_email_link_with_identity_proof", {
      p_project_id: context.projectId,
      p_member_user_id: context.memberUserId,
      p_email: context.email,
      p_linked_user_id: context.linkedUserId,
      p_created_by: context.createdBy,
      p_existing_link_id: existing?.id ?? null,
      p_expected_linked_user_id: existing?.linked_user_id ?? null,
      p_expected_snapshot_version: context.expectedSnapshotVersion,
    })
    .maybeSingle();

  const writeError = memberEmailLinkWriteError(error);
  if (writeError) return { status: "error", error: writeError };
  if (!data) {
    return {
      status: "error",
      error: "O vínculo foi alterado por outra operação.",
    };
  }
  return {
    status: "linked",
    link: data as MemberEmailLink,
    access: context.access,
  };
}

async function refreshPendingEmailLinkAfterRegistration(
  admin: MemberAdminClient,
  request: LinkOwnershipRequest,
  result: MemberEmailLinkWriteResult,
): Promise<MemberEmailLinkWriteResult> {
  if (result.status === "error" || result.access === "ready") return result;

  // The webhook may finish between the first ownership lookup and the INSERT.
  // Reconciliation now sees the registered row, so no future event is needed.
  const owner = await resolveVerifiedClerkEmailOwner("linkMemberEmail", {
    projectId: request.projectId,
    memberUserId: request.memberUserId,
    email: request.email,
  });
  if (owner.status !== "resolved") return result;

  const { data, error } = await admin
    .from("member_email_links")
    .select(
      "id, project_id, member_user_id, email, linked_user_id, created_by, created_at",
    )
    .eq("id", result.link.id)
    .eq("project_id", request.projectId)
    .maybeSingle();
  if (error) return { status: "error", error: error.message };
  if (!data) {
    return {
      status: "error",
      error: "O vínculo foi alterado por outra operação.",
    };
  }
  if (data.linked_user_id && data.linked_user_id !== owner.userId) {
    return {
      status: "error",
      error:
        "A identidade do vínculo mudou. Tente novamente para revisar a unificação.",
    };
  }
  return {
    status: "linked",
    link: data as MemberEmailLink,
    access: data.linked_user_id === owner.userId ? "ready" : "pending",
  };
}

function mappedEmailOwnerChanged(
  context: MemberEmailLinkContext,
  ownerProfile: EmailProfile | null,
): boolean {
  if (context.emailProfileState !== "mapped") return false;
  if (!context.emailProfile || !ownerProfile) return true;
  return ownerProfile.id !== context.emailProfile.id;
}

function isOwnUnverifiedEmail(
  memberUserId: string,
  context: MemberEmailLinkContext,
  ownerProfile: EmailProfile | null,
): boolean {
  if (ownerProfile) return false;
  return context.emailProfile?.id === memberUserId;
}

function memberEmailLinkValidationError(
  memberUserId: string,
  context: MemberEmailLinkContext,
  ownerProfile: EmailProfile | null,
): string | null {
  if (mappedEmailOwnerChanged(context, ownerProfile)) {
    return "Este e-mail pertence a uma identidade Clerk diferente e não pode ser reutilizado como pré-registro.";
  }
  if (ownerProfile?.id === memberUserId) {
    return "Este e-mail já pertence à conta deste membro.";
  }
  if (
    isOwnUnverifiedEmail(memberUserId, context, ownerProfile) &&
    !context.existingLink
  ) {
    return "Este já é o e-mail de pré-registro deste membro.";
  }
  return null;
}

function buildLinkUnificationContext(
  request: LinkOwnershipRequest,
  context: MemberEmailLinkContext,
  ownerProfile: EmailProfile | null,
  ownUnverifiedEmail: boolean,
): LinkUnificationContext {
  return {
    projectId: request.projectId,
    memberUserId: request.memberUserId,
    linkEmail: request.email,
    targetRole: context.targetMembership.role,
    // Um vínculo antigo pode apontar para uma identidade que já perdeu o
    // e-mail. Não reutilize o profile do target como prova de posse.
    emailProfile: ownUnverifiedEmail ? null : context.emailProfile,
    emailProfileState: ownUnverifiedEmail ? null : context.emailProfileState,
    ownerProfile,
  };
}

async function finalizeMemberEmailLink(
  admin: MemberAdminClient,
  request: LinkOwnershipRequest,
  createdBy: string,
  ownership: ResolvedLinkOwnership,
): Promise<LinkMemberEmailResult> {
  const { projectId, memberUserId, email } = request;
  const { context, ownerProfile, ownerSnapshotVersion } = ownership;
  const validationError = memberEmailLinkValidationError(
    memberUserId,
    context,
    ownerProfile,
  );
  if (validationError) return { status: "error", error: validationError };

  const ownUnverifiedEmail = isOwnUnverifiedEmail(
    memberUserId,
    context,
    ownerProfile,
  );
  const unification = await decideLinkUnification(
    admin,
    buildLinkUnificationContext(
      request,
      context,
      ownerProfile,
      ownUnverifiedEmail,
    ),
  );
  if (unification.status !== "continue") return unification;

  const linkedUserId = ownerProfile?.id ?? unification.emailProfile?.id ?? null;
  const persisted = await persistMemberEmailLink(admin, {
    projectId,
    memberUserId,
    email,
    linkedUserId,
    createdBy,
    access: ownerProfile ? "ready" : "pending",
    existingLink: context.existingLink,
    expectedSnapshotVersion: ownerSnapshotVersion,
  });
  const result = await refreshPendingEmailLinkAfterRegistration(
    admin,
    request,
    persisted,
  );
  if (result.status === "error") return result;

  revalidatePath(`/projects/${projectId}/config/members`);
  revalidateTag(`project-${projectId}-members`, TAG_PROFILE);
  return result;
}

// Vincula um e-mail adicional a um membro (US2). Casos do contrato, na ordem:
// 1. e-mail já vinculado no projeto → erro; 2. e-mail pertence a outro
// membro → retorna status requires-unification (não executa nada); 3. conta existente
// não-membro → link com linked_user_id; 4. sem conta → link pendente
// (linked_user_id NULL, vale como pré-registro do e-mail — clarificação Q2).
export async function linkMemberEmail(
  projectId: string,
  memberUserId: string,
  rawEmail: string,
): Promise<LinkMemberEmailResult> {
  const gate = await requireCoordinator(
    projectId,
    "Apenas coordenadores podem vincular e-mails.",
  );
  if (!gate.ok) return { status: "error", error: gate.error };
  const user = gate.user;

  const email = normalizeEmail(rawEmail);
  if (!email) return { status: "error", error: "E-mail inválido." };

  const admin = createSupabaseAdmin();
  const initialContext = await loadMemberEmailLinkContext(
    admin,
    projectId,
    memberUserId,
    email,
  );
  if (initialContext.status === "error") return initialContext;

  const owner = await resolveVerifiedClerkEmailOwner("linkMemberEmail", {
    projectId,
    memberUserId,
    email,
  });
  if (owner.status === "error") return owner;
  const ownership = await resolveLinkOwnership(
    admin,
    { projectId, memberUserId, email },
    initialContext.data,
    owner.status === "resolved"
      ? {
          userId: owner.userId,
          snapshotVersion: owner.snapshotVersion,
        }
      : null,
  );
  if (ownership.status === "error") return ownership;
  return finalizeMemberEmailLink(
    admin,
    { projectId, memberUserId, email },
    user.id,
    ownership.data,
  );
}

interface UnificationRequest {
  projectId: string;
  sourceUserId: string;
  targetUserId: string;
  linkEmail: string;
}

interface UnificationConflicts {
  review_conflicts: number;
  arbitration_conflicts: number;
  comparison_conflicts: number;
}

function hasUnificationConflicts(conflicts: UnificationConflicts): boolean {
  return [
    conflicts.review_conflicts,
    conflicts.arbitration_conflicts,
    conflicts.comparison_conflicts,
  ].some((count) => count > 0);
}

async function loadValidUnificationRequest(
  admin: MemberAdminClient,
  request: UnificationRequest,
): Promise<
  | { status: "valid"; sourceIsMatchingClaimablePlaceholder: boolean }
  | { status: "error"; error: string }
> {
  const [sourceResult, previewResult] = await Promise.all([
    admin
      .from("profiles")
      .select("email, activated_at")
      .eq("id", request.sourceUserId)
      .maybeSingle(),
    admin
      .rpc("preview_project_member_unification", {
        p_project_id: request.projectId,
        p_source_user_id: request.sourceUserId,
        p_target_user_id: request.targetUserId,
      })
      .maybeSingle(),
  ]);
  const error = sourceResult.error ?? previewResult.error;
  if (error) return { status: "error", error: error.message };
  if (!sourceResult.data) {
    return { status: "error", error: "O membro de origem não possui profile." };
  }
  if (!previewResult.data) {
    return {
      status: "error",
      error: "Os dois membros não estão mais disponíveis para unificação.",
    };
  }

  if (hasUnificationConflicts(previewResult.data as UnificationConflicts)) {
    return {
      status: "error",
      error: "A unificação possui conflitos que precisam ser resolvidos.",
    };
  }

  const identityState = await classifyProfileIdentity(admin, {
    id: request.sourceUserId,
    activated_at: sourceResult.data.activated_at,
  });
  if (identityState.status === "error") return identityState;

  return {
    status: "valid",
    sourceIsMatchingClaimablePlaceholder:
      identityState.state === "claimable" &&
      normalizeEmail(sourceResult.data.email) === request.linkEmail,
  };
}

async function resolveUnificationLinkedUserId(
  request: UnificationRequest,
  sourceIsMatchingClaimablePlaceholder: boolean,
): Promise<
  | {
      status: "resolved";
      userId: string;
      expectedSnapshotVersion: number | null;
    }
  | { status: "error"; error: string }
> {
  const owner = await resolveVerifiedClerkEmailOwner("unifyMembers", {
    projectId: request.projectId,
    sourceUserId: request.sourceUserId,
    targetUserId: request.targetUserId,
    email: request.linkEmail,
  });
  if (owner.status === "error") return owner;

  let userId = request.sourceUserId;
  let expectedSnapshotVersion: number | null = null;
  if (owner.status === "resolved") {
    if (
      owner.userId !== request.sourceUserId &&
      !sourceIsMatchingClaimablePlaceholder
    ) {
      return {
        status: "error",
        error: "O e-mail verificado não pertence ao membro de origem.",
      };
    }
    userId = owner.userId;
    expectedSnapshotVersion = owner.snapshotVersion;
  } else if (!sourceIsMatchingClaimablePlaceholder) {
    return {
      status: "error",
      error:
        "O e-mail não corresponde a um pré-registro pendente do membro de origem.",
    };
  }

  return userId === request.targetUserId
    ? {
        status: "error",
        error: "A conta verificada já pertence ao membro de destino.",
      }
    : { status: "resolved", userId, expectedSnapshotVersion };
}

// Executa a unificação após confirmação explícita no dialog (FR-009).
// Permanente (clarificação Q1) — a RPC migra identidade de trabalho do source
// para o target no escopo do projeto e registra o alias.
export async function unifyMembers(
  projectId: string,
  sourceUserId: string,
  targetUserId: string,
  rawLinkEmail: string,
): Promise<{ error?: string }> {
  const gate = await requireCoordinator(
    projectId,
    "Apenas coordenadores podem unificar membros.",
  );
  if (!gate.ok) return { error: gate.error };
  const user = gate.user;

  const linkEmail = normalizeEmail(rawLinkEmail);
  if (!linkEmail) return { error: "E-mail inválido." };

  const admin = createSupabaseAdmin();
  const request = { projectId, sourceUserId, targetUserId, linkEmail };
  const validation = await loadValidUnificationRequest(admin, request);
  if (validation.status === "error") return { error: validation.error };
  const identity = await resolveUnificationLinkedUserId(
    request,
    validation.sourceIsMatchingClaimablePlaceholder,
  );
  if (identity.status === "error") return { error: identity.error };

  const { error } = await admin.rpc("unify_project_members", {
    p_project_id: projectId,
    p_source_user_id: sourceUserId,
    p_target_user_id: targetUserId,
    p_linked_user_id: identity.userId,
    p_link_email: linkEmail,
    p_acting_user_id: user.id,
    p_expected_snapshot_version: identity.expectedSnapshotVersion,
  });

  if (error?.code === "40001") {
    return { error: "A posse verificada do e-mail mudou. Tente novamente." };
  }
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
  linkId: string,
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
