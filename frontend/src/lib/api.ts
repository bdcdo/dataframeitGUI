const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

/**
 * Chama o backend FastAPI. O backend exige `Authorization: Bearer <jwt>`
 * (token do Clerk, template "supabase") em todas as rotas autenticadas.
 *
 * O token NÃO é obtido aqui porque este helper roda tanto em server actions
 * quanto em client components — cada contexto pega o token de um jeito:
 *  - server actions: `fetchFastAPIServer` (lib/api-server.ts) via `auth()`;
 *  - client components: `useAuth().getToken({ template: "supabase" })`,
 *    passando o resultado em `token`.
 * O token do template expira rápido (~60s), então o caller deve buscar um
 * token fresco imediatamente antes de cada request (inclusive a cada poll).
 */
export async function fetchFastAPI<T>(
  path: string,
  options?: RequestInit,
  token?: string
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
    ...options,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(error.detail || `API error: ${res.status}`);
  }

  return res.json();
}
