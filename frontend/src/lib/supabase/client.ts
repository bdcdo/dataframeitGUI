import { createClient } from "@supabase/supabase-js";

/**
 * Creates an authenticated browser Supabase client using a Clerk JWT token.
 * Usage: const token = await getToken({ template: "supabase" });
 *        const supabase = createBrowserClient(token);
 */
export function createBrowserClient(token: string | null) {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
    }
  );
}
