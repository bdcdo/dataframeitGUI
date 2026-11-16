import "server-only";

import { auth, currentUser } from "@clerk/nextjs/server";
import { AccessLinkPendingError, fetchFastAPI } from "@/lib/api";
import {
  lacksSupabaseUid,
  readSupabaseUidFromMetadata,
} from "@/lib/clerk-supabase-uid";

/**
 * Versão de `fetchFastAPI` para Server Actions / RSC: anexa o session token do
 * Clerk automaticamente. Em client components use `fetchFastAPI` direto,
 * passando o token de `useSupabaseToken()`.
 *
 * Token sem `supabase_uid` só segue para o backend quando a conta JÁ tem o
 * vínculo na metadata: é a instância Clerk sem os custom claims (#487), e o
 * 503 do backend é a resposta certa e ruidosa. O mesmo vale, por até ~60s,
 * para o token do cookie emitido antes da gravação do vínculo: aqui não há
 * como reemiti-lo, e do servidor os dois casos são indistinguíveis.
 *
 * Sem o vínculo na metadata é o usuário que ainda não concluiu o acesso
 * (#532): o request não sai e o erro carrega a copy acionável. Mesma
 * distinção, pela mesma fonte, da barreira de `lib/supabase/server.ts` — que
 * além disso cobra `role` e trata token ilegível como sem claims, porque dali
 * ele iria ao PostgREST como `anon`; aqui o backend o recusa com 401.
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
