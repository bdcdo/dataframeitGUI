import type { User } from "@clerk/nextjs/server";

/** Chave única do vínculo Clerk↔Supabase na metadata pública da conta.
 *
 * A instância Clerk injeta esse mesmo valor no session token como o custom claim
 * `supabase_uid` (é a fonte de `clerk_uid()` do RLS). Ter a metadata e não ter o
 * claim é o que denuncia um cutover de instância mal configurado; não ter nem a
 * metadata é o usuário cujo vínculo ainda não foi reconciliado. `resolveAuth`
 * (`lib/auth.ts`) e a barreira de contrato em `lib/supabase/server.ts` leem os
 * dois lados dessa distinção — esta função centraliza o literal para que não
 * divirjam. */
export function readSupabaseUidFromMetadata(
  user: Pick<User, "publicMetadata"> | null,
): string | undefined {
  return user?.publicMetadata?.supabase_uid as string | undefined;
}
