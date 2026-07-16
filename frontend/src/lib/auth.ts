import { currentUser } from "@clerk/nextjs/server";
import { cache } from "react";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { createSupabaseServer } from "@/lib/supabase/server";

export interface AuthUser {
  id: string; // Supabase UUID
  email: string;
  firstName: string | null;
  lastName: string | null;
  clerkId: string;
  isMaster: boolean;
}

// Motivo de conclusão de acesso (data-model: Access Completion State). O caminho
// crítico só produz os quatro primeiros; `no-project-access` é decidido depois,
// no dashboard, e `unknown-recoverable` é o fallback da própria tela.
type AccessCompletionReason =
  | "link-pending"
  | "link-divergent"
  | "sync-temporary-failure";

// Resultado observável da resolução de identidade (contracts/auth-resolution).
// É a fonte única que distingue os estados que a feature precisa separar —
// substitui o antigo `AuthUser | null`, que colapsava "sem sessão", "vínculo
// pendente" e "falha técnica" num único `null` e escondia a diferença dos
// layouts protegidos.
type AuthResolution =
  | { status: "signed-out" }
  | { status: "authenticated"; user: AuthUser }
  | { status: "access-completion-required"; reason: AccessCompletionReason }
  | { status: "technical-sync-failure"; reason: AccessCompletionReason };

// Resolve o UUID Supabase da sessão SEM escrever nada (decisão D3): metadata do
// Clerk primeiro; senão, leitura read-only de `clerk_user_mapping`. Nunca chama
// `syncClerkUserToSupabase` — a criação/reparo do vínculo é responsabilidade
// explícita da ação de conclusão de acesso, fora do render protegido.
async function readSupabaseUid(
  clerkUserId: string,
  metadataUid: string | undefined,
): Promise<{ uid: string | null; mappingUid: string | null }> {
  const admin = createSupabaseAdmin();
  const { data: mapping, error: mappingError } = await admin
    .from("clerk_user_mapping")
    .select("supabase_user_id")
    .eq("clerk_user_id", clerkUserId)
    .maybeSingle();
  // Não engolir a falha em silêncio: numa leitura errada, `mapping` fica nulo e
  // a resolução segue pela metadata (autoritativa) ou cai em `link-pending`. Não
  // convertemos o erro em falha técnica de propósito — a metadata do Clerk basta
  // para autenticar e um blip transitório aqui não deve barrar quem já tem uid —,
  // mas ele precisa ficar rastreável para suporte em vez de desaparecer.
  if (mappingError) {
    console.error("[auth] leitura de clerk_user_mapping falhou", {
      clerkUserId,
      error: mappingError,
    });
  }
  const mappingUid = mapping?.supabase_user_id ?? null;
  return { uid: metadataUid ?? mappingUid, mappingUid };
}

/**
 * Resolução de identidade autenticada, request-scoped e read-only.
 *
 * `cache()` deduplica a resolução Clerk + lookups em `clerk_user_mapping` /
 * `master_users` / `profiles` quando vários layouts, pages e helpers da mesma
 * request pedem a identidade (RC-001 / SC-002). Não faz nenhuma escrita: quando
 * o vínculo interno está ausente, pendente ou divergente, retorna
 * `access-completion-required` para que a página protegida falhe fechada e
 * redirecione à conclusão de acesso (FR-008), em vez de reparar no render.
 */
export const resolveAuth = cache(async (): Promise<AuthResolution> => {
  // Observabilidade de SC-002 (T010): como o corpo do `cache()` roda uma vez por
  // request, cada execução aqui é uma resolução real. Com o flag ligado, o log
  // por request confirma que a identidade é resolvida uma vez, não por leitura.
  // Server-only e opt-in — nunca vaza para o cliente nem polui logs por padrão.
  if (process.env.AUTH_RESOLVE_DEBUG === "1") {
    console.info("[auth] resolveAuth: nova resolução de identidade na request");
  }

  const user = await currentUser();
  if (!user) return { status: "signed-out" };

  const metadataUid = user.publicMetadata.supabase_uid as string | undefined;
  const email = user.emailAddresses[0]?.emailAddress;

  const { uid, mappingUid } = await readSupabaseUid(user.id, metadataUid);

  // Vínculo ainda não existe. Com e-mail utilizável, é pendente e recuperável
  // por retry; sem e-mail, não há como concluir o vínculo automaticamente —
  // falha técnica recuperável (data-model: validação de Authenticated Actor).
  if (!uid) {
    if (!email) {
      return { status: "technical-sync-failure", reason: "sync-temporary-failure" };
    }
    return { status: "access-completion-required", reason: "link-pending" };
  }

  // Metadata e mapping apontam para identidades incompatíveis: não adivinhar
  // qual vale — encaminhar para reparo (data-model: active → divergent).
  if (metadataUid && mappingUid && metadataUid !== mappingUid) {
    return { status: "access-completion-required", reason: "link-divergent" };
  }

  const admin = createSupabaseAdmin();
  const { data: masterRow, error: masterError } = await admin
    .from("master_users")
    .select("user_id")
    .eq("user_id", uid)
    .maybeSingle();
  // `isMaster` degrada com segurança para false quando a leitura falha (menos
  // privilégio), mas não em silêncio: sem log, um master rebaixado por um timeout
  // transitório seria indistinguível de um não-master legítimo.
  if (masterError) {
    console.error("[auth] leitura de master_users falhou", {
      supabaseUid: uid,
      error: masterError,
    });
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
      email: email ?? "",
      firstName: user.firstName,
      lastName: user.lastName,
      clerkId: user.id,
      isMaster: !!masterRow,
    },
  };
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

type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServer>>;

async function resolveCanonicalMemberId(
  supabase: SupabaseServerClient,
  projectId: string,
  userId: string,
): Promise<string> {
  const { data: alias, error: aliasError } = await supabase
    .from("member_email_links")
    .select("member_user_id")
    .eq("project_id", projectId)
    .eq("linked_user_id", userId)
    .maybeSingle();

  if (aliasError) {
    console.error("getEffectiveMemberId: alias query failed", {
      projectId,
      userId,
      error: aliasError.message,
    });
    throw new Error("Não foi possível resolver a identidade no projeto.");
  }

  return alias?.member_user_id ?? userId;
}

// Identidade efetiva do usuário num projeto (spec 002): se a conta atual está
// vinculada como alias de um membro (member_email_links.linked_user_id), todo
// o trabalho no projeto acontece como o membro canônico (member_user_id);
// senão, como ela própria. `cache()` deduplica por request — páginas e actions
// do mesmo render pedem a mesma resolução.
export const getEffectiveMemberId = cache(
  async (projectId: string): Promise<string> => {
    const user = await getAuthUser();
    if (!user) throw new Error("Não autenticado");

    const supabase = await createSupabaseServer();
    return resolveCanonicalMemberId(supabase, projectId, user.id);
  },
);

export async function resolveProjectActor(
  projectId: string,
): Promise<
  | { ok: true; user: AuthUser; effectiveUserId: string }
  | { ok: false; error: string }
> {
  const user = await getAuthUser();
  if (!user) return { ok: false, error: "Não autenticado" };
  try {
    return {
      ok: true,
      user,
      effectiveUserId: await getEffectiveMemberId(projectId),
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Não foi possível resolver a identidade no projeto.",
    };
  }
}

// Identidade efetiva das páginas de fila pessoal (Codificar, Comparação,
// Arbitragem, Meus vereditos): a impersonação master (?viewAsUser=) tem
// precedência; sem ela, contas vinculadas resolvem para o membro canônico do
// projeto via getEffectiveMemberId (spec 002). Fonte única da precedência —
// antes cada página reimplementava o par isMaster && viewAsUser, e as que não
// o fizeram (Comparação/Arbitragem) filtravam a fila pelo id do master logado,
// mostrando fila vazia durante a impersonação.
export async function resolveEffectiveUserId(
  projectId: string,
  user: Pick<AuthUser, "id" | "isMaster">,
  viewAsUser: string | undefined,
): Promise<{ effectiveUserId: string; isImpersonating: boolean }> {
  if (user.isMaster && viewAsUser) {
    return { effectiveUserId: viewAsUser, isImpersonating: true };
  }
  return {
    effectiveUserId: await getEffectiveMemberId(projectId),
    isImpersonating: false,
  };
}

interface ProjectAccessContext {
  project: { id: string; name: string; created_by: string } | null;
  membershipRole: string | null;
  isCoordinator: boolean;
  effectiveUserId: string;
  // true quando alguma das queries falhou (timeout, RLS, etc.). Permite ao
  // chamador distinguir "nao e coordenador" de "nao foi possivel verificar".
  queryFailed: boolean;
}

// Centraliza project + membership do usuario numa unica leitura request-scoped.
// `cache()` deduplica entre o layout pai do projeto, layouts filhos (config,
// llm, analyze) e pages da mesma request — todos pedem os mesmos dados.
export const getProjectAccessContext = cache(
  async (
    projectId: string,
    userId: string,
    isMaster: boolean,
  ): Promise<ProjectAccessContext> => {
    const supabase = await createSupabaseServer();
    const effectiveUserId = await resolveCanonicalMemberId(
      supabase,
      projectId,
      userId,
    );

    const [
      { data: project, error: projectError },
      { data: membership, error: membershipError },
    ] = await Promise.all([
      supabase
        .from("projects")
        .select("id, name, created_by")
        .eq("id", projectId)
        .maybeSingle(),
      supabase
        .from("project_members")
        .select("role")
        .eq("project_id", projectId)
        .eq("user_id", effectiveUserId)
        .maybeSingle(),
    ]);

    // Falhas de query (timeout, RLS rejeitando o que deveria ler, etc.) nao
    // devem ser silenciosamente convertidas em "nao e coordenador" — logamos e
    // sinalizamos via `queryFailed` para nao mascarar lockout de coordenador
    // legitimo como falta de permissao.
    if (projectError) {
      console.error("getProjectAccessContext: project query failed", {
        projectId,
        userId,
        error: projectError.message,
      });
    }
    if (membershipError) {
      console.error("getProjectAccessContext: membership query failed", {
        projectId,
        userId,
        error: membershipError.message,
      });
    }

    const isCoordinator =
      isMaster ||
      project?.created_by === effectiveUserId ||
      membership?.role === "coordenador";

    return {
      project: project ?? null,
      membershipRole: membership?.role ?? null,
      isCoordinator,
      effectiveUserId,
      queryFailed: !!projectError || !!membershipError,
    };
  },
);

// Helper para server actions: falha cedo com mensagem clara em vez de deixar o
// RLS retornar erro generico. Fail-closed por design — em erro de query retorna
// `false`, porque mutation nunca deve fail-open. Guards de leitura (layouts)
// devem usar `getProjectAccessContext` direto e tratar `queryFailed`.
export async function isProjectCoordinator(
  projectId: string,
  user: AuthUser,
): Promise<boolean> {
  try {
    const { isCoordinator, queryFailed } = await getProjectAccessContext(
      projectId,
      user.id,
      user.isMaster,
    );
    return !queryFailed && isCoordinator;
  } catch {
    return false;
  }
}

// Gate combinado (auth + coordenador) para Server Actions coordinator-only.
// União discriminada em vez de lançar: cada caller adapta {ok:false,error} pro
// próprio shape de retorno (heterogêneo entre callers — ver comparisons.ts,
// field-reviews.ts, documents.ts), então fixar um shape único aqui forçaria
// os callers a normalizar depois.
export async function requireCoordinator(
  projectId: string,
  deniedMessage: string,
): Promise<
  | { ok: true; user: AuthUser; effectiveUserId: string }
  | { ok: false; error: string }
> {
  const user = await getAuthUser();
  if (!user) return { ok: false, error: "Não autenticado" };
  let context: ProjectAccessContext;
  try {
    context = await getProjectAccessContext(projectId, user.id, user.isMaster);
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Não foi possível verificar a permissão no projeto.",
    };
  }
  if (context.queryFailed) {
    return {
      ok: false,
      error: "Não foi possível verificar a permissão no projeto.",
    };
  }
  if (!context.isCoordinator) {
    return { ok: false, error: deniedMessage };
  }
  return { ok: true, user, effectiveUserId: context.effectiveUserId };
}
