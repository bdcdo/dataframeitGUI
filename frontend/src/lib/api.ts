const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

/** Session token indisponível (deslogado ou sessão expirada). Distinto de um 401
 * do backend: aqui o request nem chega a sair, então o caller mostra uma causa
 * acionável em vez de um "API error: 401" genérico. */
class MissingAuthTokenError extends Error {
  constructor() {
    super("Sessão indisponível. Faça login novamente.");
    this.name = "MissingAuthTokenError";
  }
}

type GetToken = () => Promise<string | null>;

/** Busca o session token do Clerk e falha fechado (lança) quando vem nulo, em
 * vez de mandar um request sem `Authorization` que o backend rejeitaria com um
 * 401 ambíguo. Use em client components antes de cada request/poll. */
export async function requireSupabaseToken(getToken: GetToken): Promise<string> {
  const token = await getToken();
  if (!token) throw new MissingAuthTokenError();
  return token;
}

/**
 * Chama o backend FastAPI. O backend exige `Authorization: Bearer <jwt>`
 * (session token do Clerk) em todas as rotas autenticadas.
 *
 * O token NÃO é obtido aqui porque este helper roda tanto em server actions
 * quanto em client components — cada contexto pega o token de um jeito:
 *  - server actions: `fetchFastAPIServer` (lib/api-server.ts) via `auth()`;
 *  - client components: `useAuth().getToken()`, passando o resultado em `token`.
 * O session token expira rápido (~60s), então o caller deve buscar um token
 * fresco imediatamente antes de cada request (inclusive a cada poll).
 */
export async function fetchFastAPI<T>(
  path: string,
  options?: RequestInit,
  token?: string
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    // `...options` vem ANTES de `headers`: spread de objeto substitui a chave
    // inteira, não faz merge. Na ordem inversa, um caller que passasse
    // `options.headers` apagaria de uma vez o Content-Type e o Authorization
    // montados aqui — o token sairia do request sem nenhum sinal.
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
      // Authorization derivado do `token` prevalece sobre options.headers: o
      // token explícito do caller nunca deve ser sobrescrito por um header solto.
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(error.detail || `API error: ${res.status}`);
  }

  return res.json();
}
