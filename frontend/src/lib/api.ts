const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

/** Token do template "supabase" indisponível (deslogado, sessão expirada ou o
 * template não existe na instância do Clerk). Distinto de um 401 do backend:
 * aqui o request nem chega a sair, então o caller mostra uma causa acionável em
 * vez de um "API error: 401" genérico. */
class MissingAuthTokenError extends Error {
  constructor() {
    super(
      "Sessão indisponível ou template 'supabase' não configurado no Clerk.",
    );
    this.name = "MissingAuthTokenError";
  }
}

type GetToken = (opts: { template: string }) => Promise<string | null>;

/** Busca o JWT do template "supabase" e falha fechado (lança) quando vem nulo,
 * em vez de mandar um request sem `Authorization` que o backend rejeitaria com
 * um 401 ambíguo. Use em client components antes de cada request/poll. */
export async function requireSupabaseToken(getToken: GetToken): Promise<string> {
  const token = await getToken({ template: "supabase" });
  if (!token) throw new MissingAuthTokenError();
  return token;
}

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
      ...options?.headers,
      // Authorization derivado do `token` prevalece sobre options.headers: o
      // token explícito do caller nunca deve ser sobrescrito por um header solto.
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...options,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(error.detail || `API error: ${res.status}`);
  }

  return res.json();
}
