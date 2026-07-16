import { currentUser } from "@clerk/nextjs/server";
import { unstable_rethrow } from "next/navigation";
import { cache } from "react";
import { getVerifiedPrimaryEmail } from "@/lib/clerk-primary-email";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { createSupabaseServer } from "@/lib/supabase/server";
import type { Project, ProjectMember } from "@/lib/types";
import { PROJECT_IDENTITY_UNAVAILABLE_MESSAGE } from "@/lib/project-access";

export interface AuthUser {
  id: string; // Supabase UUID
  email: string;
  firstName: string | null;
  lastName: string | null;
  clerkId: string;
  isMaster: boolean;
}

// Resultado observável da resolução de identidade (contracts/auth-resolution).
// É a fonte única que distingue os estados que a feature precisa separar —
// substitui o antigo `AuthUser | null`, que colapsava "sem sessão", "vínculo
// pendente" e "falha técnica" num único `null` e escondia a diferença dos
// layouts protegidos.
export type AuthResolution =
  | { status: "signed-out" }
  | { status: "authenticated"; user: AuthUser }
  | {
      status: "access-completion-required";
      reason: "link-pending" | "link-divergent";
      actorEmail: string;
    }
  | {
      status: "technical-sync-failure";
      reason: "sync-temporary-failure";
      actorEmail?: string;
    };

function technicalSyncFailure(actorEmail?: string): AuthResolution {
  return {
    status: "technical-sync-failure",
    reason: "sync-temporary-failure",
    ...(actorEmail ? { actorEmail } : {}),
  };
}

// Resolve o UUID Supabase da sessão SEM escrever nada (decisão D3): exige que
// metadata do Clerk e `clerk_user_mapping` existam simultaneamente. Nunca chama
// `reconcileClerkUserAccess` — a criação/reparo do vínculo é responsabilidade
// explícita da ação de conclusão de acesso, fora do render protegido.
type SupabaseIdentityRead =
  | { status: "resolved"; uid: string; mappingUid: string }
  | { status: "pending" }
  | { status: "unavailable" };

async function readSupabaseUid(
  clerkUserId: string,
  metadataUid: string | undefined,
): Promise<SupabaseIdentityRead> {
  const admin = createSupabaseAdmin();
  const { data: mapping, error: mappingError } = await admin
    .from("clerk_user_mapping")
    .select("supabase_user_id, access_sync_version")
    .eq("clerk_user_id", clerkUserId)
    .maybeSingle();
  // A leitura também valida que metadata e mapping continuam coerentes. Se ela
  // falha, autenticar apenas pela metadata esconderia uma divergência possível.
  if (mappingError) {
    console.error("[auth] leitura de clerk_user_mapping falhou", {
      clerkUserId,
      error: mappingError,
    });
    return { status: "unavailable" };
  }
  const mappingUid = mapping?.supabase_user_id ?? null;
  // Os dois lados são necessários: a metadata alimenta o JWT/RLS e o mapping
  // confirma o vínculo interno. Aceitar apenas um produziria duas identidades
  // observáveis diferentes na mesma request.
  if (
    !metadataUid ||
    !mapping ||
    !mappingUid ||
    mapping.access_sync_version < 1
  ) {
    return { status: "pending" };
  }
  return { status: "resolved", uid: metadataUid, mappingUid };
}

/**
 * Resolução de identidade autenticada, request-scoped e read-only.
 *
 * `cache()` deduplica a resolução Clerk + lookups em `clerk_user_mapping` e
 * `master_users` quando vários layouts, pages e helpers da mesma request pedem
 * a identidade (RC-001 / SC-002). Não faz nenhuma escrita: quando
 * o vínculo interno está ausente, pendente ou divergente, retorna
 * `access-completion-required` para que a página protegida falhe fechada e
 * redirecione à conclusão de acesso (FR-008), em vez de reparar no render.
 */
async function resolveAuthUncached(): Promise<AuthResolution> {
  const user = await currentUser();
  if (!user) return { status: "signed-out" };

  const metadataUid = user.publicMetadata.supabase_uid as string | undefined;
  const email = getVerifiedPrimaryEmail(user);

  // AuthUser exige o e-mail primário verificado em qualquer estado do vínculo.
  // Um secundário não pode substituir silenciosamente a identidade canônica.
  if (!email) {
    return technicalSyncFailure();
  }

  const identity = await readSupabaseUid(user.id, metadataUid);

  if (identity.status === "unavailable") {
    return technicalSyncFailure(email);
  }

  // Vínculo ainda não existe, mas o e-mail necessário para repará-lo já foi
  // validado acima.
  if (identity.status === "pending") {
    return {
      status: "access-completion-required",
      reason: "link-pending",
      actorEmail: email,
    };
  }

  const { uid, mappingUid } = identity;

  // Metadata e mapping apontam para identidades incompatíveis: não adivinhar
  // qual vale — encaminhar para reparo (data-model: active → divergent).
  if (uid !== mappingUid) {
    return {
      status: "access-completion-required",
      reason: "link-divergent",
      actorEmail: email,
    };
  }

  const admin = createSupabaseAdmin();
  const { data: masterRow, error: masterError } = await admin
    .from("master_users")
    .select("user_id")
    .eq("user_id", uid)
    .maybeSingle();
  // Sem confirmar `master_users`, não existe um `AuthUser` completo: rebaixar
  // silenciosamente um master para não-master esconderia uma falha de autorização.
  if (masterError) {
    console.error("[auth] leitura de master_users falhou", {
      supabaseUid: uid,
      error: masterError,
    });
    return technicalSyncFailure(email);
  }

  // Nota (decisão D3): a ativação de perfil (`activated_at`) NÃO acontece aqui.
  // Este caminho é read-only por design — a ativação é reparo de vínculo e vive
  // fora do render: no webhook `user.created` (com retry do Svix) e na ação
  // `completeAccess` da tela de conclusão. Não recolocar a escrita neste ponto:
  // além de reintroduzir mutação no caminho crítico, ela quebraria os testes de
  // contagem de lookups (auth-request-dedup / auth-no-remote-lookup).
  return {
    status: "authenticated",
    user: {
      id: uid,
      email,
      firstName: user.firstName,
      lastName: user.lastName,
      clerkId: user.id,
      isMaster: !!masterRow,
    },
  };
}

export const resolveAuth = cache(async (): Promise<AuthResolution> => {
  // Observabilidade de SC-002 (T010): como o corpo do `cache()` roda uma vez por
  // request, cada execução aqui é uma resolução real. Com o flag ligado, o log
  // por request confirma que a identidade é resolvida uma vez, não por leitura.
  // Server-only e opt-in — nunca vaza para o cliente nem polui logs por padrão.
  if (process.env.AUTH_RESOLVE_DEBUG === "1") {
    console.info("[auth] resolveAuth: nova resolução de identidade na request");
  }

  try {
    return await resolveAuthUncached();
  } catch (error) {
    // APIs dinâmicas e navegação do Next usam exceções como controle de fluxo.
    // Preservá-las evita classificar prerender/redirect como falha do Clerk.
    unstable_rethrow(error);
    console.error("[auth] resolução de identidade falhou", { error });
    return technicalSyncFailure();
  }
});

/**
 * Retorna o usuário autenticado ou `null`. Fina camada sobre `resolveAuth` para
 * os muitos callers (actions, pages) que só precisam do par autenticado/não —
 * eles já tratam `null` como fail-closed. Layouts que precisam distinguir
 * "vínculo pendente" de "sem sessão" devem usar `resolveAuth` diretamente.
 */
export const getAuthUser = cache(async (): Promise<AuthUser | null> => {
  const resolution = await resolveAuth();
  return resolution.status === "authenticated" ? resolution.user : null;
});

export interface ResolvedProjectAccessContext {
  status: "resolved";
  accountUserId: string;
  memberUserId: string;
  project: Pick<Project, "id" | "name" | "created_by"> | null;
  membershipRole: ProjectMember["role"] | null;
  isMaster: boolean;
  isCoordinator: boolean;
}

export interface UnavailableProjectAccessContext {
  status: "unavailable";
}

export type ProjectAccessContext =
  ResolvedProjectAccessContext | UnavailableProjectAccessContext;

type ProjectMemberIdentity =
  { status: "resolved"; memberUserId: string } | { status: "unavailable" };

type ProjectAccessRead =
  | {
      status: "resolved";
      project: ResolvedProjectAccessContext["project"];
      membershipRole: ProjectMember["role"] | null;
    }
  | UnavailableProjectAccessContext;

// A identidade é uma operação independente das leituras de projeto/papel e é
// reutilizada por actions pessoais que não precisam dessas duas queries.
const resolveProjectMemberIdentity = cache(
  async (
    projectId: string,
    accountUserId: string,
  ): Promise<ProjectMemberIdentity> => {
    try {
      const supabase = await createSupabaseServer();
      const { data: alias, error } = await supabase
        .from("member_email_links")
        .select("member_user_id")
        .eq("project_id", projectId)
        .eq("linked_user_id", accountUserId)
        // A migration torna impossível uma conta apontar para dois membros
        // canônicos no mesmo projeto. O limite evita materializar aliases
        // redundantes sem duplicar essa validação na aplicação.
        .limit(1)
        .maybeSingle();

      if (error) {
        console.error("resolveProjectMemberIdentity: query failed", {
          projectId,
          accountUserId,
          error: error.message,
        });
        return { status: "unavailable" };
      }

      return {
        status: "resolved",
        memberUserId: alias?.member_user_id ?? accountUserId,
      };
    } catch (error) {
      console.error("resolveProjectMemberIdentity: query rejected", {
        projectId,
        accountUserId,
        error,
      });
      return { status: "unavailable" };
    }
  },
);

async function readProjectAccess(
  projectId: string,
  accountUserId: string,
  memberUserId: string,
): Promise<ProjectAccessRead> {
  try {
    const supabase = await createSupabaseServer();
    const [projectResult, membershipResult] = await Promise.all([
      supabase
        .from("projects")
        .select("id, name, created_by")
        .eq("id", projectId)
        .maybeSingle(),
      supabase
        .from("project_members")
        .select("role")
        .eq("project_id", projectId)
        .eq("user_id", memberUserId)
        .maybeSingle(),
    ]);

    if (projectResult.error) {
      console.error("getProjectAccessContext: project query failed", {
        projectId,
        accountUserId,
        error: projectResult.error.message,
      });
    }
    if (membershipResult.error) {
      console.error("getProjectAccessContext: membership query failed", {
        projectId,
        accountUserId,
        memberUserId,
        error: membershipResult.error.message,
      });
    }
    if (projectResult.error || membershipResult.error) {
      return { status: "unavailable" };
    }

    return {
      status: "resolved",
      project: projectResult.data ?? null,
      membershipRole: membershipResult.data?.role ?? null,
    };
  } catch (error) {
    console.error("getProjectAccessContext: access queries failed", {
      projectId,
      accountUserId,
      memberUserId,
      error,
    });
    return { status: "unavailable" };
  }
}

// Cache da leitura composta de projeto/papel. Os argumentos primitivos garantem
// que layouts e pages dedupliquem a mesma resolução mesmo quando recebem
// objetos AuthUser distintos com os mesmos dados.
const getProjectAccessContextCached = cache(
  async (
    projectId: string,
    accountUserId: string,
    isMaster: boolean,
  ): Promise<ProjectAccessContext> => {
    const identity = await resolveProjectMemberIdentity(
      projectId,
      accountUserId,
    );
    if (identity.status === "unavailable") {
      return { status: "unavailable" };
    }
    const { memberUserId } = identity;

    const access = await readProjectAccess(
      projectId,
      accountUserId,
      memberUserId,
    );
    if (access.status === "unavailable") {
      return access;
    }
    const { project, membershipRole } = access;

    return {
      status: "resolved",
      accountUserId,
      memberUserId,
      project,
      membershipRole,
      isMaster,
      // A autoria do projeto pertence à conta que o criou; o papel pertence ao
      // membro canônico. Não combinar a membership bruta com a canônica.
      isCoordinator:
        isMaster ||
        project?.created_by === accountUserId ||
        membershipRole === "coordenador",
    };
  },
);

// Porta pública única para identidade, projeto e papel. O caller fornece o
// ator autenticado, nunca ids soltos capazes de divergir entre si.
export function getProjectAccessContext(
  projectId: string,
  user: Pick<AuthUser, "id" | "isMaster">,
): Promise<ProjectAccessContext> {
  return getProjectAccessContextCached(projectId, user.id, user.isMaster);
}

type ProjectMemberActorResult =
  | { ok: true; user: AuthUser; memberUserId: string }
  | {
      ok: false;
      code: "unauthenticated" | "identity_unavailable";
      error: string;
    };

// Porta única para mutations pessoais: resolve a conta autenticada e sua
// identidade canônica no projeto como um único contrato, sem transformar
// falhas técnicas em "não autenticado".
export const resolveProjectMemberActor = cache(
  async (projectId: string): Promise<ProjectMemberActorResult> => {
    const resolution = await resolveAuth();
    if (resolution.status === "signed-out") {
      return { ok: false, code: "unauthenticated", error: "Não autenticado" };
    }
    if (resolution.status !== "authenticated") {
      return {
        ok: false,
        code: "identity_unavailable",
        error: PROJECT_IDENTITY_UNAVAILABLE_MESSAGE,
      };
    }

    const identity = await resolveProjectMemberIdentity(
      projectId,
      resolution.user.id,
    );
    if (identity.status === "unavailable") {
      return {
        ok: false,
        code: "identity_unavailable",
        error: PROJECT_IDENTITY_UNAVAILABLE_MESSAGE,
      };
    }

    return {
      ok: true,
      user: resolution.user,
      memberUserId: identity.memberUserId,
    };
  },
);

// Resolve apenas a identidade exibida pela fila. O ?viewAsUser= global só tem
// efeito para master e não altera o ator autenticado usado pelas mutations.
export function resolveProjectQueueIdentity(
  access: ResolvedProjectAccessContext,
  viewAsUser: string | undefined,
): {
  ownMemberUserId: string;
  queueUserId: string;
  isImpersonating: boolean;
} {
  if (access.isMaster && viewAsUser) {
    return {
      ownMemberUserId: access.memberUserId,
      queueUserId: viewAsUser,
      isImpersonating: true,
    };
  }
  return {
    ownMemberUserId: access.memberUserId,
    queueUserId: access.memberUserId,
    isImpersonating: false,
  };
}

export type RequireCoordinatorResult =
  | { ok: true; user: AuthUser }
  | {
      ok: false;
      code: "unauthenticated" | "forbidden" | "authorization_unavailable";
      error: string;
    };

const AUTHORIZATION_UNAVAILABLE_MESSAGE =
  "Não foi possível verificar sua permissão. Tente novamente.";

// Gate único das mutations coordinator-only. Falhas técnicas são observáveis e
// retornadas como estado, nunca rebaixadas para "forbidden" nem propagadas como
// rejection. Master mantém o atalho global e não consulta identidade/projeto.
export async function requireCoordinator(
  projectId: string,
  deniedMessage: string,
): Promise<RequireCoordinatorResult> {
  const resolution = await resolveAuth();

  if (resolution.status === "signed-out") {
    return { ok: false, code: "unauthenticated", error: "Não autenticado" };
  }
  if (resolution.status !== "authenticated") {
    return {
      ok: false,
      code: "authorization_unavailable",
      error: AUTHORIZATION_UNAVAILABLE_MESSAGE,
    };
  }
  const { user } = resolution;
  if (user.isMaster) return { ok: true, user };

  const access = await getProjectAccessContext(projectId, user);
  if (access.status === "unavailable") {
    return {
      ok: false,
      code: "authorization_unavailable",
      error: AUTHORIZATION_UNAVAILABLE_MESSAGE,
    };
  }
  if (!access.isCoordinator) {
    return { ok: false, code: "forbidden", error: deniedMessage };
  }
  return { ok: true, user };
}
