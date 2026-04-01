import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { clerkClient } from "@clerk/nextjs/server";

/**
 * Ensures a Clerk user has a corresponding Supabase auth.users record
 * and a row in clerk_user_mapping.  Returns the Supabase UUID.
 * Idempotent — safe to call concurrently for the same user.
 */
export async function syncClerkUserToSupabase(
  clerkUserId: string,
  email: string,
  firstName?: string | null,
  lastName?: string | null
): Promise<string> {
  const admin = createSupabaseAdmin();
  const clerk = await clerkClient();

  // Check if mapping already exists
  const { data: existing } = await admin
    .from("clerk_user_mapping")
    .select("supabase_user_id")
    .eq("clerk_user_id", clerkUserId)
    .single();

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
