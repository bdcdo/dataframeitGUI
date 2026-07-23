import { createClient } from "@supabase/supabase-js";
import { auth } from "@clerk/nextjs/server";

/** O contrato que a RLS exige do session token do Clerk:
 *  - `supabase_uid`: lido por `clerk_uid()` (migration 20260401200000), que toda
 *    policy usa como identidade;
 *  - `role: "authenticated"`: sem ele o PostgREST trata a request como `anon`.
 *
 * Os dois são custom claims configurados no Dashboard (Sessions → Customize
 * session token), não claims default — e o Postgres não reclama quando faltam:
 * `clerk_uid()` vira NULL e as policies simplesmente não casam. */
type TokenClaims = { supabase_uid?: string; role?: string };

/** Lê o payload do JWT SEM verificar a assinatura. Não é validação: quem valida
 * é o Supabase, contra o JWKS do Clerk. É uma asserção de contrato — o token
 * acabou de vir do `auth()` do Clerk neste mesmo processo. */
function decodeClaims(token: string): TokenClaims {
  const payload = token.split(".")[1];
  if (!payload) return {};
  try {
    // O `catch` cobre base64/JSON inválido; o teste de tipo cobre o que ele não
    // pega — JSON válido que não é objeto (`null`, número, string). Sem ele, um
    // payload `null` passaria daqui e a destructuring em `assertTokenContract`
    // lançaria um TypeError cru no lugar do erro nomeado.
    const claims: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString(),
    );
    return typeof claims === "object" && claims !== null
      ? (claims as TokenClaims)
      : {};
  } catch {
    return {};
  }
}

/** Falha alto quando o token não carrega o que a RLS precisa.
 *
 * Sem isto, um claim ausente é INVISÍVEL: `resolveAuth` aprova (lê o
 * `supabase_uid` da metadata do usuário, não do token), a RLS nega tudo, e a
 * aplicação renderiza normalmente com todas as listas vazias — sem erro em lugar
 * nenhum. É o modo de falha mais provável de uma troca de instância Clerk, e o
 * único ponto do read path onde dá para pegá-lo: um SELECT que volta com zero
 * linhas é indistinguível de "este usuário não tem projeto".
 *
 * Ressalva de alcance: `resolveProjectMemberIdentity` e `readProjectAccess`
 * (`lib/auth.ts`) envolvem a criação do cliente em try/catch e traduzem qualquer
 * exceção em `{ status: "unavailable" }`. Nesses dois call sites a causa nomeada
 * sobrevive só no `console.error` deles — a tela mostra indisponibilidade
 * genérica. Para os demais consumidores o erro sobe de verdade. */
function assertTokenContract(token: string): void {
  const { supabase_uid, role } = decodeClaims(token);
  // Não ecoar o valor recebido: ele vem de um token cuja assinatura não foi
  // verificada aqui, e nomear a claim ausente já basta para agir.
  const missing = [
    !supabase_uid && "supabase_uid",
    role !== "authenticated" && 'role="authenticated"',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(
      `Session token do Clerk sem ${missing.join(" e ")}. A RLS negaria tudo em ` +
        `silêncio. Conferir os custom claims em Sessions → Customize session ` +
        `token na instância do Clerk.`,
    );
  }
}

export async function createSupabaseServer() {
  const { getToken } = await auth();
  const supabaseToken = await getToken();
  if (supabaseToken) assertTokenContract(supabaseToken);

  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: {
        headers: supabaseToken
          ? { Authorization: `Bearer ${supabaseToken}` }
          : {},
      },
    }
  );
}

export type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServer>>;
