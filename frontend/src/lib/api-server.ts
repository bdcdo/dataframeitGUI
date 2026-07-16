import "server-only";

import { auth } from "@clerk/nextjs/server";
import { fetchFastAPI } from "@/lib/api";

/**
 * Versão de `fetchFastAPI` para Server Actions / RSC: anexa o session token do
 * Clerk automaticamente. Em client components use `fetchFastAPI` direto,
 * passando o token de `useAuth().getToken()`.
 */
export async function fetchFastAPIServer<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const { getToken } = await auth();
  const token = await getToken();
  return fetchFastAPI<T>(path, options, token ?? undefined);
}
