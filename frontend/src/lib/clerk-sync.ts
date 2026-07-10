import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { clerkClient } from "@clerk/nextjs/server";

/**
 * Ensures a Clerk user has a corresponding Supabase auth.users record
 * and a row in clerk_user_mapping.  Returns the Supabase UUID.
 * Idempotent — safe to call concurrently for the same user.
 */
/**
 * Cria um placeholder Supabase-only para pré-registro de membro (spec 002):
 * auth.users com email confirmado + profiles via trigger handle_new_user,
 * com activated_at = NULL (pendente). Não cria usuário Clerk — o auto-join
 * acontece no signup real, quando syncClerkUserToSupabase mapeia o novo
 * Clerk user para este profile pelo e-mail.
 * Idempotente: e-mail já existente (profile ou auth.users) retorna o id atual.
 */
export async function preregisterSupabaseUser(email: string): Promise<string> {
  const admin = createSupabaseAdmin();

  const { data: profile } = await admin
    .from("profiles")
    .select("id")
    .eq("email", email)
    .single();
  if (profile) return profile.id;

  const { data, error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
  });

  if (error) {
    // Race entre dois pré-registros do mesmo e-mail: o trigger
    // handle_new_user do vencedor já criou o profile — re-consultar profiles
    // resolve sem depender de listUsers (paginado em 50, não escala).
    const { data: raced } = await admin
      .from("profiles")
      .select("id")
      .eq("email", email)
      .single();
    if (raced) return raced.id;

    // Último recurso: auth.users órfão de profile (estado anômalo).
    const { data: existingUsers } = await admin.auth.admin.listUsers();
    const match = existingUsers?.users?.find((u) => u.email === email);
    if (match) return match.id;
    throw new Error(`Erro ao criar usuário Supabase: ${error.message}`);
  }

  return data.user.id;
}

/**
 * Marca um profile pré-registrado como ativado no primeiro login real
 * (activated_at). Idempotente por design: o filtro `.is("activated_at", null)`
 * só grava quando ainda está pendente, então repetir a conclusão de acesso não
 * "reativa" nem sobrescreve o instante original. Relocada para fora de
 * `getAuthUser` (decisão D3): a ativação é reparo de vínculo e não deve rodar no
 * render path protegido — só na conclusão de acesso explícita.
 */
export async function activateProfileIfPending(
  supabaseUserId: string
): Promise<void> {
  const admin = createSupabaseAdmin();
  await admin
    .from("profiles")
    .update({ activated_at: new Date().toISOString() })
    .eq("id", supabaseUserId)
    .is("activated_at", null);
}

export async function syncClerkUserToSupabase(
  clerkUserId: string,
  email: string,
  firstName?: string | null,
  lastName?: string | null
): Promise<string> {
  const admin = createSupabaseAdmin();
  const [clerk, { data: existing }] = await Promise.all([
    clerkClient(),
    admin
      .from("clerk_user_mapping")
      .select("supabase_user_id")
      .eq("clerk_user_id", clerkUserId)
      .single(),
  ]);

  if (existing) return existing.supabase_user_id;

  // Check if a profile with this email already exists (pre-existing user)
  const { data: profile } = await admin
    .from("profiles")
    .select("id")
    .eq("email", email)
    .single();

  let supabaseUid: string;

  if (profile) {
    supabaseUid = profile.id;
  } else {
    // Try to create; if email already exists (race), fetch existing user instead
    const { data, error } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
    });

    if (error) {
      // Handle race: email already exists
      const { data: existingUsers } = await admin.auth.admin.listUsers();
      const match = existingUsers?.users?.find(
        (u) => u.email === email
      );
      if (match) {
        supabaseUid = match.id;
      } else {
        throw new Error(`Erro ao criar usuario Supabase: ${error.message}`);
      }
    } else {
      supabaseUid = data.user.id;
    }

    // Update profile names
    if (firstName || lastName) {
      await admin
        .from("profiles")
        .update({
          ...(firstName && { first_name: firstName }),
          ...(lastName && { last_name: lastName }),
        })
        .eq("id", supabaseUid);
    }
  }

  // Insert mapping for this Clerk user. If the Supabase UUID is already linked
  // to a stale Clerk user, reassign that row to avoid legacy migration lock.
  const { error: upsertError } = await admin.from("clerk_user_mapping").upsert({
    clerk_user_id: clerkUserId,
    supabase_user_id: supabaseUid,
  });

  if (upsertError) {
    const { data: ownerMapping } = await admin
      .from("clerk_user_mapping")
      .select("clerk_user_id")
      .eq("supabase_user_id", supabaseUid)
      .single();

    if (ownerMapping?.clerk_user_id) {
      const { error: deleteError } = await admin
        .from("clerk_user_mapping")
        .delete()
        .eq("clerk_user_id", ownerMapping.clerk_user_id);
      if (deleteError) {
        throw new Error(
          `Erro ao remover mapping legado: ${deleteError.message}`
        );
      }

      const { error: insertError } = await admin
        .from("clerk_user_mapping")
        .insert({
          clerk_user_id: clerkUserId,
          supabase_user_id: supabaseUid,
        });
      if (insertError) {
        throw new Error(
          `Erro ao reassociar mapping para usuario atual: ${insertError.message}`
        );
      }
    } else {
      throw new Error(`Erro ao gravar mapping: ${upsertError.message}`);
    }
  }

  // Store supabase_uid in Clerk metadata so the JWT template can use it
  await clerk.users.updateUserMetadata(clerkUserId, {
    publicMetadata: { supabase_uid: supabaseUid },
  });

  return supabaseUid;
}
