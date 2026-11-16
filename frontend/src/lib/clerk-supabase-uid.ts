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

/** O contrato que a RLS e o backend FastAPI exigem do session token do Clerk:
 *  - `supabase_uid`: lido por `clerk_uid()` (migration 20260401200000), que toda
 *    policy usa como identidade, e por `verify_jwt` no backend;
 *  - `role: "authenticated"`: sem ele o PostgREST trata a request como `anon`.
 *
 * Os dois são custom claims configurados no Dashboard (Sessions → Customize
 * session token), não claims default — e o Postgres não reclama quando faltam:
 * `clerk_uid()` vira NULL e as policies simplesmente não casam. */
export type SessionTokenClaims = { supabase_uid?: string; role?: string };

/** Lê o payload do session token SEM verificar a assinatura. Não é validação:
 * quem valida é quem recebe o token (Supabase e FastAPI, contra o JWKS do
 * Clerk). Serve para conferir, antes de o request sair, se o token carrega o
 * que o destino exige. `null` quando o texto não é um JWT legível — julgar esse
 * token é papel de quem o verifica.
 *
 * `atob` + `TextDecoder`, e não `Buffer`: roda igual no servidor e no browser
 * (`lib/api.ts` é importado por client components). */
export function readSessionTokenClaims(token: string): SessionTokenClaims | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    // O `catch` cobre base64/JSON inválido; o teste de tipo cobre o que ele não
    // pega — JSON válido que não é objeto (`null`, número, string).
    const claims: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof claims === "object" && claims !== null
      ? (claims as SessionTokenClaims)
      : null;
  } catch {
    return null;
  }
}
