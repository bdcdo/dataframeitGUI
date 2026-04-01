/**
 * One-time script to migrate existing Supabase users to Clerk.
 *
 * For each profile in Supabase:
 * 1. Creates a Clerk user (or finds existing by email)
 * 2. Sets publicMetadata.supabase_uid = Supabase UUID
 * 3. Inserts row into clerk_user_mapping
 *
 * Usage:
 *   npx tsx scripts/sync-existing-users-to-clerk.ts
 *   npx tsx scripts/sync-existing-users-to-clerk.ts --dry-run --limit=20
 *
 * Required env vars (reads from .env.local automatically):
 *   CLERK_SECRET_KEY
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "@supabase/supabase-js";
import { createClerkClient } from "@clerk/backend";
import { config } from "dotenv";
import { resolve } from "path";

// Load .env.local
config({ path: resolve(__dirname, "../.env.local") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !CLERK_SECRET_KEY) {
  console.error("Faltam variaveis de ambiente. Verifique .env.local");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const clerk = createClerkClient({ secretKey: CLERK_SECRET_KEY });

interface Profile {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
}

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const limitArg = args.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : null;

if (limitArg && (!Number.isInteger(limit) || (limit as number) <= 0)) {
  console.error("Parametro --limit invalido. Use inteiro positivo, ex: --limit=20");
  process.exit(1);
}

async function main() {
  console.log("Buscando profiles no Supabase...");

  const { data: profiles, error } = await supabase
    .from("profiles")
    .select("id, email, first_name, last_name");

  if (error) {
    console.error("Erro ao buscar profiles:", error.message);
    process.exit(1);
  }

  const allProfiles = (profiles as Profile[]) ?? [];
  const targetProfiles =
    limit && allProfiles.length > limit ? allProfiles.slice(0, limit) : allProfiles;

  if (targetProfiles.length === 0) {
    console.log("Nenhum profile encontrado.");
    return;
  }

  if (isDryRun) {
    console.log("MODO DRY-RUN: nenhuma escrita em Clerk/Supabase sera realizada.");
  }

  console.log(
    `Encontrados ${allProfiles.length} profiles. Processando ${targetProfiles.length}.\n`
  );

  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (const profile of targetProfiles) {
    const label = `${profile.email} (${profile.id})`;

    // Check if mapping already exists
    const { data: existing } = await supabase
      .from("clerk_user_mapping")
      .select("clerk_user_id")
      .eq("supabase_user_id", profile.id)
      .single();

    if (existing) {
      console.log(`  SKIP  ${label} — ja mapeado para ${existing.clerk_user_id}`);
      skipped++;
      continue;
    }

    try {
      // Try to find existing Clerk user by email
      const existingUsers = await clerk.users.getUserList({
        emailAddress: [profile.email],
      });

      let clerkUserId: string;

      if (existingUsers.data.length > 0) {
        clerkUserId = existingUsers.data[0].id;
        console.log(`  FOUND ${label} — Clerk user ${clerkUserId} ja existe`);
      } else {
        // Create new Clerk user
        const clerkUser = await clerk.users.createUser({
          emailAddress: [profile.email],
          firstName: profile.first_name || undefined,
          lastName: profile.last_name || undefined,
          skipPasswordRequirement: true,
        });
        clerkUserId = clerkUser.id;
        console.log(`  CREATE ${label} — Clerk user ${clerkUserId}`);
      }

      if (isDryRun) {
        console.log(
          `  DRY   ${label} — validado (clerk_user_id=${clerkUserId})`
        );
      } else {
        // Set supabase_uid in Clerk metadata
        await clerk.users.updateUserMetadata(clerkUserId, {
          publicMetadata: { supabase_uid: profile.id },
        });

        // Insert mapping
        const { error: mapError } = await supabase
          .from("clerk_user_mapping")
          .upsert({
            clerk_user_id: clerkUserId,
            supabase_user_id: profile.id,
          });

        if (mapError) {
          console.error(`  ERROR ${label} — mapping: ${mapError.message}`);
          errors++;
          continue;
        }
      }

      created++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  ERROR ${label} — ${msg}`);
      errors++;
    }
  }

  console.log(`\n--- Resultado ---`);
  console.log(`  Criados/vinculados: ${created}`);
  console.log(`  Ja existiam:        ${skipped}`);
  console.log(`  Erros:              ${errors}`);
  console.log(`  Total processados:  ${targetProfiles.length}`);
  console.log(`  Total encontrados:  ${allProfiles.length}`);
}

main().catch((e) => {
  console.error("Erro fatal:", e);
  process.exit(1);
});
