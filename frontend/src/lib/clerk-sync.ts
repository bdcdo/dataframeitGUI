import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { clerkClient } from "@clerk/nextjs/server";
import { isClerkAPIResponseError } from "@clerk/nextjs/errors";
import type { User } from "@clerk/nextjs/server";
import { getVerifiedEmailIdentity } from "@/lib/clerk-primary-email";

type SupabaseAdmin = ReturnType<typeof createSupabaseAdmin>;

type SupabaseUserMapping = {
  supabaseUserId: string;
};

type PreregisteredProfile = {
  id: string;
  activated_at: string | null;
};

async function readSupabaseUserMapping(
  admin: SupabaseAdmin,
  clerkUserId: string,
): Promise<SupabaseUserMapping | null> {
  const { data, error } = await admin
    .from("clerk_user_mapping")
    .select("supabase_user_id")
    .eq("clerk_user_id", clerkUserId)
    .maybeSingle();
  if (error) {
    throw new Error(
      `Erro ao consultar mapping Clerk-Supabase: ${error.message}`,
    );
  }
  return data
    ? {
        supabaseUserId: data.supabase_user_id,
      }
    : null;
}

async function requireUnclaimedPlaceholder(
  admin: SupabaseAdmin,
  profile: PreregisteredProfile,
): Promise<string> {
  if (profile.activated_at !== null) {
    throw new Error("Este e-mail já pertence a uma conta ativa");
  }

  const { data: mapping, error } = await admin
    .from("clerk_user_mapping")
    .select("clerk_user_id")
    .eq("supabase_user_id", profile.id)
    .maybeSingle();
  if (error) {
    throw new Error(`Erro ao verificar mapping Clerk: ${error.message}`);
  }
  if (mapping) {
    throw new Error("Este pré-registro já pertence a uma conta Clerk");
  }
  return profile.id;
}

/**
 * Localiza a identidade Supabase pelo profile, que é a representação exigida
 * pela aplicação, ou cria auth.users e deixa o trigger criar esse profile.
 * Uma falha de createUser só é tratada como corrida quando a releitura prova
 * que o profile concorrente já existe.
 */
async function findOrCreatePreregisteredSupabaseUser(
  admin: SupabaseAdmin,
  email: string,
): Promise<string> {
  const { data: profile, error: profileReadError } = await admin
    .from("profiles")
    .select("id, activated_at")
    .eq("email", email)
    .maybeSingle();

  if (profileReadError) {
    throw new Error(`Erro ao consultar profile: ${profileReadError.message}`);
  }
  if (profile) return requireUnclaimedPlaceholder(admin, profile);

  const { data, error: createUserError } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
  });

  if (!createUserError && data.user) {
    return requireUnclaimedPlaceholder(admin, {
      id: data.user.id,
      activated_at: null,
    });
  }

  if (!createUserError) {
    throw new Error("Erro ao criar usuário Supabase: resposta sem usuário");
  }

  const { data: racedProfile, error: racedProfileReadError } = await admin
    .from("profiles")
    .select("id, activated_at")
    .eq("email", email)
    .maybeSingle();

  if (racedProfileReadError) {
    throw new Error(
      `Erro ao reconsultar profile: ${racedProfileReadError.message}`,
    );
  }
  if (racedProfile) return requireUnclaimedPlaceholder(admin, racedProfile);

  throw new Error(`Erro ao criar usuário Supabase: ${createUserError.message}`);
}

/**
 * Cria um placeholder Supabase-only para pré-registro de membro (spec 002):
 * auth.users com email confirmado + profiles via trigger handle_new_user,
 * com activated_at = NULL (pendente). Não cria usuário Clerk — o auto-join
 * acontece no signup real, quando reconcileClerkUserAccess mapeia o novo
 * Clerk user para este profile pelo e-mail.
 */
export async function preregisterSupabaseUser(email: string): Promise<string> {
  return findOrCreatePreregisteredSupabaseUser(
    createSupabaseAdmin(),
    email.trim().toLowerCase(),
  );
}

/**
 * Faz o metadata do Clerk convergir para o UUID canônico persistido no
 * mapping. A operação é idempotente e precisa terminar antes de o sync
 * declarar sucesso, pois o JWT do Clerk lê esse mesmo campo.
 */
async function persistSupabaseUidInClerkMetadata(
  clerkUserId: string,
  supabaseUid: string,
): Promise<void> {
  const clerk = await clerkClient();
  await clerk.users.updateUserMetadata(clerkUserId, {
    publicMetadata: { supabase_uid: supabaseUid },
  });
}

/**
 * Garante o auth.users e o clerk_user_mapping da conta Clerk e devolve o UUID
 * Supabase persistido. Não publica a metadata que torna o vínculo autenticável:
 * essa é a última etapa de reconcileClerkUserAccess, depois dos efeitos locais.
 */
async function claimSupabaseUserMapping(
  admin: SupabaseAdmin,
  clerkUserId: string,
  email: string,
): Promise<SupabaseUserMapping | null> {
  const { data, error } = await admin.rpc("claim_clerk_supabase_identity", {
    p_clerk_user_id: clerkUserId,
    p_email: email,
  });
  if (error) {
    throw new Error(`Erro ao vincular identidade Clerk: ${error.message}`);
  }
  return data ? { supabaseUserId: data as string } : null;
}

async function ensureSupabaseUserMapping(
  admin: SupabaseAdmin,
  clerkUserId: string,
  email: string,
): Promise<SupabaseUserMapping> {
  const existing = await readSupabaseUserMapping(admin, clerkUserId);
  if (existing) return existing;

  // A RPC serializa o claim com as demais operações de identidade. Só um
  // placeholder pendente e ainda sem mapping pode ser reclamado; profiles
  // ativos e mappings de outra conta Clerk falham fechados.
  const claimed = await claimSupabaseUserMapping(admin, clerkUserId, email);
  if (claimed) return claimed;

  const { data, error: createUserError } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
  });

  if (!createUserError && !data.user) {
    throw new Error("Erro ao criar usuário Supabase: resposta sem usuário");
  }

  // O trigger de auth.users cria o profile. Tanto o caminho de sucesso quanto
  // uma corrida de createUser voltam à mesma RPC; nenhum conflito reatribui um
  // UID já pertencente a outra identidade.
  const createdOrRaced = await claimSupabaseUserMapping(
    admin,
    clerkUserId,
    email,
  );
  if (createdOrRaced) return createdOrRaced;

  if (createUserError) {
    throw new Error(
      `Erro ao criar usuário Supabase: ${createUserError.message}`,
    );
  }
  throw new Error("Erro ao criar usuário Supabase: profile não foi criado");
}

async function applyClerkAccessSnapshot(
  admin: SupabaseAdmin,
  user: User,
  supabaseUserId: string,
  verifiedEmails: readonly string[],
  activate: boolean,
): Promise<boolean> {
  const snapshotIdentity = {
    p_clerk_user_id: user.id,
    p_supabase_user_id: supabaseUserId,
    p_snapshot_version: user.updatedAt,
  };
  const { data: began, error: beginError } = await admin.rpc(
    "begin_clerk_access_snapshot",
    snapshotIdentity,
  );
  if (beginError) {
    throw new Error(
      `Erro ao iniciar snapshot de acesso: ${beginError.message}`,
    );
  }
  if (began !== true) return false;

  const { data: completed, error: completeError } = await admin.rpc(
    "complete_clerk_access_snapshot",
    {
      ...snapshotIdentity,
      p_verified_emails: [...verifiedEmails],
      p_first_name: user.firstName,
      p_last_name: user.lastName,
      p_activate: activate,
    },
  );
  if (completeError) {
    throw new Error(
      `Erro ao concluir snapshot de acesso: ${completeError.message}`,
    );
  }
  return completed === true;
}

/**
 * Sequência completa usada pelos dois pontos de entrada de recuperação:
 * webhook do Clerk e ação explícita da tela de conclusão de acesso.
 */
async function reconcileCurrentClerkUserAccess(
  user: User,
): Promise<
  | { status: "applied"; supabaseUserId: string | null }
  | { status: "superseded" }
> {
  const emailIdentity = getVerifiedEmailIdentity(user);
  const admin = createSupabaseAdmin();
  if (!emailIdentity) {
    const mapping = await readSupabaseUserMapping(admin, user.id);
    if (mapping) {
      const applied = await applyClerkAccessSnapshot(
        admin,
        user,
        mapping.supabaseUserId,
        [],
        false,
      );
      if (!applied) return { status: "superseded" };
    }
    return { status: "applied", supabaseUserId: null };
  }

  const mapping = await ensureSupabaseUserMapping(
    admin,
    user.id,
    emailIdentity.primaryEmail,
  );
  const applied = await applyClerkAccessSnapshot(
    admin,
    user,
    mapping.supabaseUserId,
    emailIdentity.verifiedEmails,
    true,
  );
  if (!applied) return { status: "superseded" };

  // A metadata alimenta o JWT/RLS e é sempre o último efeito. Um user.updated
  // disparado por esta escrita observa o mesmo UID e não escreve metadata de
  // novo, encerrando o ciclo de webhook.
  const observedSupabaseUid = user.publicMetadata.supabase_uid;
  if (observedSupabaseUid !== mapping.supabaseUserId) {
    await persistSupabaseUidInClerkMetadata(user.id, mapping.supabaseUserId);
  }
  return { status: "applied", supabaseUserId: mapping.supabaseUserId };
}

export async function reconcileClerkUserAccess(
  clerkUserId: string,
): Promise<string | null> {
  const clerk = await clerkClient();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await reconcileCurrentClerkUserAccess(
        await clerk.users.getUser(clerkUserId),
      );
      if (result.status === "applied") return result.supabaseUserId;
    } catch (error) {
      if (isClerkAPIResponseError(error) && error.status === 404) {
        await revokeClerkUserAccess(clerkUserId);
        return null;
      }
      throw error;
    }
  }
  throw new Error("O estado Clerk mudou durante a reconciliação de acesso");
}

/**
 * Revoga o estado autenticável de uma conta removida ou sem identidade útil.
 * Profiles e histórico permanecem; mapping versão 0 e aliases vazios tornam
 * tokens antigos e endereços removidos inaptos a conceder acesso.
 */
export async function revokeClerkUserAccess(
  clerkUserId: string,
): Promise<void> {
  const admin = createSupabaseAdmin();
  const { data: supabaseUserId, error: beginError } = await admin.rpc(
    "begin_clerk_user_revocation",
    {
      p_clerk_user_id: clerkUserId,
    },
  );
  if (beginError) {
    throw new Error(`Erro ao iniciar revogação Clerk: ${beginError.message}`);
  }
  if (!supabaseUserId) return;

  const { data: completed, error: completeError } = await admin.rpc(
    "complete_clerk_user_revocation",
    {
      p_clerk_user_id: clerkUserId,
      p_supabase_user_id: supabaseUserId,
    },
  );
  if (completeError) {
    throw new Error(
      `Erro ao concluir revogação Clerk: ${completeError.message}`,
    );
  }
  if (completed !== true) {
    throw new Error("Erro ao concluir revogação Clerk: mapping mudou");
  }
}

export type ReconciledClerkEmailOwner =
  | { status: "resolved"; userId: string; snapshotVersion: number }
  | { status: "unowned" }
  | { status: "changed" };

async function reloadVerifiedClerkEmailOwner(
  clerk: Awaited<ReturnType<typeof clerkClient>>,
  clerkUserId: string,
  email: string,
): Promise<User | null> {
  let user: User;
  try {
    user = await clerk.users.getUser(clerkUserId);
  } catch (error) {
    if (!isClerkAPIResponseError(error) || error.status !== 404) throw error;
    await revokeClerkUserAccess(clerkUserId);
    return null;
  }

  const identity = getVerifiedEmailIdentity(user);
  return identity?.verifiedEmails.includes(email) ? user : null;
}

async function reconcileVerifiedOwnerSnapshot(
  user: User,
): Promise<Awaited<ReturnType<typeof reconcileCurrentClerkUserAccess>> | null> {
  try {
    return await reconcileCurrentClerkUserAccess(user);
  } catch (error) {
    if (!isClerkAPIResponseError(error) || error.status !== 404) throw error;
    // A conta pode desaparecer depois da releitura e antes da publicação de
    // metadata. Nesse caso o webhook de exclusão pode ter observado ausência
    // de mapping; revogar novamente fecha a identidade criada nessa janela.
    await revokeClerkUserAccess(user.id);
    return null;
  }
}

/**
 * Prova e reconcilia a posse atual de um e-mail em uma única operação. O ID
 * retornado pela busca nunca escapa como credencial: a conta é relida e o
 * mesmo e-mail precisa continuar verificado no snapshot que será aplicado.
 */
export async function reconcileVerifiedClerkEmailOwner(
  rawEmail: string,
): Promise<ReconciledClerkEmailOwner> {
  const email = rawEmail.trim().toLowerCase();
  const clerk = await clerkClient();
  const { data: users } = await clerk.users.getUserList({
    emailAddress: [email],
    limit: 2,
  });
  const owners = users.filter((user) =>
    getVerifiedEmailIdentity(user)?.verifiedEmails.includes(email),
  );
  if (owners.length > 1) {
    throw new Error("Mais de uma conta Clerk possui o e-mail verificado");
  }
  const owner = owners[0];
  if (!owner) return { status: "unowned" };

  for (let attempt = 0; attempt < 2; attempt++) {
    const currentUser = await reloadVerifiedClerkEmailOwner(
      clerk,
      owner.id,
      email,
    );
    if (!currentUser) return { status: "changed" };

    const result = await reconcileVerifiedOwnerSnapshot(currentUser);
    if (!result) return { status: "changed" };
    if (result.status === "applied") {
      if (!result.supabaseUserId) {
        throw new Error("Snapshot verificado sem identidade Supabase");
      }
      return {
        status: "resolved",
        userId: result.supabaseUserId,
        snapshotVersion: currentUser.updatedAt,
      };
    }
  }

  return { status: "changed" };
}
