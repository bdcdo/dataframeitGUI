import "server-only";

import { auth, currentUser } from "@clerk/nextjs/server";
import { AccessLinkPendingError, fetchFastAPI, lacksSupabaseUid } from "@/lib/api";
import { readSupabaseUidFromMetadata } from "@/lib/clerk-supabase-uid";

/**
 * Versão de `fetchFastAPI` para Server Actions / RSC: anexa o session token do
 * Clerk automaticamente. Em client components use `fetchFastAPI` direto,
 * passando o token de `requireSupabaseToken(useAuth().getToken)`.
 *
 * Token sem `supabase_uid` só segue para o backend quando a conta JÁ tem o
 * vínculo na metadata: é a instância Clerk sem os custom claims (#487) ou um
 * token emitido antes da gravação, e o 503 do backend é a resposta certa e
 * ruidosa. Sem o vínculo na metadata é o usuário que ainda não concluiu o
 * acesso (#532): o request não sai e o erro carrega a copy acionável. Mesma
 * distinção, pela mesma fonte, da barreira de `lib/supabase/server.ts`;
 * `currentUser()` é deduplicado por request e só é lido no caminho degradado.
 */
export async function fetchFastAPIServer<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const { getToken } = await auth();
  const token = await getToken();
  if (
    token &&
    lacksSupabaseUid(token) &&
    !readSupabaseUidFromMetadata(await currentUser())
  ) {
    throw new AccessLinkPendingError();
  }
  return fetchFastAPI<T>(path, options, token ?? undefined);
}
