import { currentUser } from "@clerk/nextjs/server";
import { syncClerkUserToSupabase } from "@/lib/clerk-sync";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

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
 */
export async function getAuthUser(): Promise<AuthUser | null> {
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
}
