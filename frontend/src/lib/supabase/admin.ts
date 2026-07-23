import "server-only";

import { createClient } from "@supabase/supabase-js";

function runtimeConfig(): { supabaseUrl: string; serviceRoleKey: string } {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "Supabase admin client requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY",
    );
  }
  return { supabaseUrl, serviceRoleKey };
}

export function createSupabaseAdmin() {
  const { supabaseUrl, serviceRoleKey } = runtimeConfig();

  return createClient(
    supabaseUrl,
    serviceRoleKey,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
