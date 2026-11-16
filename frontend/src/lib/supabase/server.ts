import { createClient } from "@supabase/supabase-js";
import { auth, currentUser } from "@clerk/nextjs/server";
import {
  readSessionTokenClaims,
  readSupabaseUidFromMetadata,
} from "@/lib/clerk-supabase-uid";

/** Falha alto quando o token não carrega o que a RLS precisa — MAS só quando a
 * ausência denuncia config quebrada, não um vínculo ainda pendente.
 *
 * O modo de falha que isto pega: numa troca de instância Clerk os custom claims
 * não são replicados, então `resolveAuth` aprova (lê o `supabase_uid` da
 * metadata do usuário, não do token), a RLS nega tudo, e a aplicação renderiza
 * com todas as listas vazias — sem erro em lugar nenhum. Um SELECT que volta com
 * zero linhas é indistinguível de "este usuário não tem projeto", e este é o
 * único ponto do read path onde dá para pegá-lo.
 *
 * Mas do token puro esse cutover é IDÊNTICO a um estado legítimo: o usuário
 * recém-criado cujo vínculo ainda não foi reconciliado (`link-pending`) também
 * tem sessão Clerk sem `supabase_uid`. Lançar para ele transformaria o redirect
 * gracioso da conclusão de acesso num crash — e como toda página protegida faz
 * `Promise.all([requirePageAuthUser(), createSupabaseServer()])`, a rejeição
 * rápida daqui venceria o `redirect()` (que espera um round-trip de
 * `currentUser()`), determinística e em ~17 páginas.
 *
 * A metadata pública do Clerk distingue os dois — é a mesma fonte que o token
 * carrega como claim (ver `readSupabaseUidFromMetadata`): no cutover a metadata
 * TEM o uid (só o token não replicou), no pending ainda NÃO tem. `currentUser()`
 * é deduplicado por request pelo Clerk — na página protegida `resolveAuth` já o
 * buscou, custo ~zero — e só é consultado no caminho degradado (token sem
 * claim). Ler a metadata em vez de importar `resolveAuth` evita o ciclo de
 * import (`lib/auth` importa este módulo de volta).
 *
 * Ressalva: um `link-divergent` (metadata presente, mas divergente do mapping)
 * cai no ramo "lança" caso o token traga `supabase_uid` mas não `role` — combinação
 * improvável (os dois claims saem da mesma config de sessão) e cujo efeito é um
 * erro VISÍVEL num usuário já em fluxo de reparo, não o silêncio que a barreira
 * existe para evitar.
 *
 * Ressalva de alcance: `resolveProjectMemberIdentity` e `readProjectAccess`
 * (`lib/auth.ts`) envolvem a criação do cliente em try/catch e traduzem qualquer
 * exceção em `{ status: "unavailable" }`. Nesses dois call sites a causa nomeada
 * sobrevive só no `console.error` deles. Para os demais consumidores o erro
 * sobe de verdade. */
async function assertTokenContract(token: string): Promise<void> {
  // Token ilegível conta como token sem os claims: daqui ele iria direto ao
  // PostgREST, que o trataria como `anon` no mesmo silêncio.
  const { supabase_uid, role } = readSessionTokenClaims(token) ?? {};
  // Não ecoar o valor recebido: ele vem de um token cuja assinatura não foi
  // verificada aqui, e nomear a claim ausente já basta para agir.
  const missing = [
    !supabase_uid && "supabase_uid",
    role !== "authenticated" && 'role="authenticated"',
  ].filter(Boolean);
  if (missing.length === 0) return;

  // Token sem o claim. Só é config quebrada se a conta JÁ tem o vínculo na
  // metadata (cutover); sem ele, é um usuário cujo acesso ainda não foi
  // reconciliado, e a página protegida já redireciona para a conclusão de
  // acesso — lançar aqui atropelaria esse redirect.
  const user = await currentUser();
  if (!readSupabaseUidFromMetadata(user)) return;

  throw new Error(
    `Session token do Clerk sem ${missing.join(" e ")}. A RLS negaria tudo em ` +
      `silêncio. Conferir os custom claims em Sessions → Customize session ` +
      `token na instância do Clerk.`,
  );
}

export async function createSupabaseServer() {
  const { getToken } = await auth();
  const supabaseToken = await getToken();
  if (supabaseToken) await assertTokenContract(supabaseToken);

  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
      global: {
        headers: supabaseToken
          ? { Authorization: `Bearer ${supabaseToken}` }
          : {},
      },
    }
  );
}

export type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServer>>;
