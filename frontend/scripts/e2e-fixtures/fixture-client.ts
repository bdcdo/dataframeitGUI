import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadE2eEnvironment } from "../worktree-env/env-contract.mjs";

// O começo comum dos geradores de fixture E2E (coding, compare e
// llm-decisions), que cada um repetia: carregar o ambiente com a precedência
// de `loadE2eEnvironment` (E2E_ENV_PATH, senão .env.e2e, sobre o .env.local),
// exigir URL, chave de service role e os dois e-mails E2E, e abrir o cliente.

export const FRONTEND_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface FixtureEnvironment {
  url: string;
  serviceRoleKey: string;
  coordinatorEmail: string;
  memberEmail: string;
}

/**
 * Lê e confere o ambiente da fixture. `localOnly` recusa um Supabase que não
 * seja local (a fixture de llm-decisions só nasce no banco local).
 */
export function fixtureEnvironment(
  { localOnly = false }: { localOnly?: boolean } = {},
  env: Record<string, string | undefined> = process.env,
  frontendDir: string = FRONTEND_DIR,
): FixtureEnvironment {
  loadE2eEnvironment(env, frontendDir);
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes");
  }
  const host = new URL(url).hostname;
  if (localOnly && !/^(localhost|127\.0\.0\.1)$/.test(host)) {
    throw new Error(
      `NEXT_PUBLIC_SUPABASE_URL aponta para ${host}: esta fixture só é criada no Supabase local (ver E2E_ENV_PATH em .env.e2e.example)`,
    );
  }
  const coordinatorEmail = env.E2E_COORDINATOR_EMAIL;
  const memberEmail = env.E2E_MEMBER_EMAIL;
  if (!coordinatorEmail || !memberEmail) {
    throw new Error(
      "E2E_COORDINATOR_EMAIL / E2E_MEMBER_EMAIL ausentes — configure frontend/.env.e2e (ver .env.e2e.example)",
    );
  }
  return { url, serviceRoleKey, coordinatorEmail, memberEmail };
}

/** Cliente de service role e os e-mails E2E, com o host impresso. */
export function fixtureClient(options: { localOnly?: boolean } = {}): {
  supabase: SupabaseClient;
  coordinatorEmail: string;
  memberEmail: string;
} {
  const { url, serviceRoleKey, coordinatorEmail, memberEmail } = fixtureEnvironment(options);
  console.log(`Supabase: ${new URL(url).host}`);
  const supabase = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  return { supabase, coordinatorEmail, memberEmail };
}
