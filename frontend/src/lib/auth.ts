import { currentUser } from "@clerk/nextjs/server";

export interface AuthUser {
  id: string; // Supabase UUID
  email: string;
  firstName: string | null;
  lastName: string | null;
  clerkId: string;
}

/**
 * Returns the authenticated user with their Supabase UUID as `id`.
 * Drop-in replacement for the old `supabase.auth.getUser()` pattern.
 */
export async function getAuthUser(): Promise<AuthUser | null> {
  const user = await currentUser();
  if (!user) return null;

  const supabaseUid = user.publicMetadata.supabase_uid as string | undefined;
  if (!supabaseUid) return null;

  return {
    id: supabaseUid,
    email: user.emailAddresses[0]?.emailAddress ?? "",
    firstName: user.firstName,
    lastName: user.lastName,
    clerkId: user.id,
  };
}
