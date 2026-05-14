import { currentUser } from "@clerk/nextjs/server";
import { cache } from "react";
import { syncClerkUserToSupabase } from "@/lib/clerk-sync";
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

async function resolveSupabaseUidFromClerk(): Promise<{
  user: Awaited<ReturnType<typeof currentUser>>;
  supabaseUid: string | null;
}> {
  const user = await currentUser();
  if (!user) {
    return { user: null, supabaseUid: null };
  }

  const metadataUid = user.publicMetadata.supabase_uid as string | undefined;
  if (metadataUid) {
    return { user, supabaseUid: metadataUid };
  }

  const email = user.emailAddresses[0]?.emailAddress;
  if (!email) {
    return { user, supabaseUid: null };
  }

  try {
    const syncedUid = await syncClerkUserToSupabase(
      user.id,
      email,
      user.firstName,
      user.lastName
    );
    return { user, supabaseUid: syncedUid };
  } catch (error) {
    console.error("Failed to sync Clerk user to Supabase", {
      clerkUserId: user.id,
      error,
    });
    return { user, supabaseUid: null };
  }
}

/**
 * Returns the authenticated user with their Supabase UUID as `id`.
 * Drop-in replacement for the old `supabase.auth.getUser()` pattern.
 *
 * `cache()` deduplica a resolucao Clerk + lookup em `master_users` quando
 * varios layouts/pages da mesma request chamam `getAuthUser()`.
 */
export const getAuthUser = cache(async (): Promise<AuthUser | null> => {
  const { user, supabaseUid } = await resolveSupabaseUidFromClerk();
  if (!user) return null;
  if (!supabaseUid) return null;

  const admin = createSupabaseAdmin();
  const { data: masterRow } = await admin
    .from("master_users")
    .select("user_id")
    .eq("user_id", supabaseUid)
    .maybeSingle();

  return {
    id: supabaseUid,
    email: user.emailAddresses[0]?.emailAddress ?? "",
    firstName: user.firstName,
    lastName: user.lastName,
    clerkId: user.id,
    isMaster: !!masterRow,
  };
});

export interface ProjectAccessContext {
  project: { id: string; name: string; created_by: string } | null;
  membershipRole: string | null;
  isCoordinator: boolean;
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
        .eq("user_id", userId)
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
      project?.created_by === userId ||
      membership?.role === "coordenador";

    return {
      project: project ?? null,
      membershipRole: membership?.role ?? null,
      isCoordinator,
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
  const { isCoordinator } = await getProjectAccessContext(
    projectId,
    user.id,
    user.isMaster,
  );
  return isCoordinator;
}
