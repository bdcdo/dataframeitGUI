import { readSessionTokenClaims } from "@/lib/clerk-supabase-uid";
import { serverErrorCopy, UserFacingError } from "@/lib/server-error";

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

/** Sessão válida cujo token ainda não carrega o vínculo com os dados
 * (`supabase_uid`). O backend responderia 503 "Autenticação mal configurada no
 * servidor" — certo para a instância Clerk sem os custom claims (#487), mas sem
 * ação possível para quem só não concluiu o acesso (#532). O request não sai, e
 * a copy diz o que fazer: recarregar leva a página protegida a conduzir a pessoa
 * à conclusão de acesso (`/auth/post-login`).
 *
 * `UserFacingError`: é estado esperado com copy pronta, então os `catch` das
 * actions a devolvem como veio em vez de trocá-la pela genérica do fluxo. */
export class AccessLinkPendingError extends UserFacingError {
  constructor() {
    super(
      "Seu acesso ainda não foi concluído. Recarregue a página para concluir o acesso.",
    );
    this.name = "AccessLinkPendingError";
  }
}

/** `true` quando o token é um JWT legível sem `supabase_uid`. Token ilegível
 * não entra aqui: quem o julga é o backend, que responde 401. */
export function lacksSupabaseUid(token: string): boolean {
  const claims = readSessionTokenClaims(token);
  return claims !== null && !claims.supabase_uid;
}

/** Resposta não-ok do backend. Carrega o status para o caller separar o 4xx,
 * cujo `detail` é copy pt-BR escrita para o usuário ("Projeto não possui código
 * Pydantic armazenado"), do 5xx, que é falha de servidor e vai para o log. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// Reason phrase que o roteador do Starlette devolve como `detail` para rota ou
// método inexistente (frontend publicado antes do backend, que tem deploy
// próprio): inglês de protocolo, não copy.
const ROUTER_DEFAULT_DETAIL: Record<number, string> = {
  404: "Not Found",
  405: "Method Not Allowed",
};

/** Texto do toast para uma resposta não-ok. O `detail` string do backend é copy
 * pt-BR escrita para o usuário (4xx e os 503 da autenticação) e passa como está.
 * O resto é diagnóstico e vai para o log: o 422 de validação do FastAPI, cujo
 * `detail` é uma lista de objetos; o corpo que não é JSON (HTML de proxy), de
 * que só sobra o `statusText` em inglês; o 500, que o backend colapsa em
 * "Internal Server Error"; e o 404/405 padrão do roteador. */
function apiErrorCopy(path: string, status: number, statusText: string, body: unknown): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  const isCopy =
    typeof detail === "string" &&
    detail !== "" &&
    status !== 500 &&
    detail !== ROUTER_DEFAULT_DETAIL[status];
  if (isCopy) return detail;
  const raw = typeof detail === "string" || detail === undefined ? detail : JSON.stringify(detail);
  return serverErrorCopy(
    `[api] ${path} falhou`,
    { code: String(status), message: raw || statusText },
    {
      generic:
        status >= 500
          ? `Erro no servidor (HTTP ${status}). Tente novamente.`
          : `O servidor recusou a requisição (HTTP ${status}).`,
    },
  );
}

type GetToken = (options?: { skipCache?: boolean }) => Promise<string | null>;

/** Busca o session token do Clerk e falha fechado (lança) quando ele não serve
 * ao backend, em vez de mandar um request que voltaria com um erro sem ação.
 * Use em client components antes de cada request/poll.
 *
 *  - Token nulo (deslogado, sessão expirada): `MissingAuthTokenError`.
 *  - Token sem `supabase_uid`: o token em cache pode ter sido emitido antes de
 *    o vínculo ser gravado na metadata (o webhook ou a conclusão de acesso
 *    rodaram depois), então uma reemissão com `skipCache` é tentada uma vez. Se
 *    o claim continua ausente, `AccessLinkPendingError` — o request não sai.
 *
 * Daqui não dá para separar o vínculo pendente da instância Clerk sem os custom
 * claims (#487): o cliente só vê o token. A separação fica com o servidor — na
 * instância mal configurada, o recarregamento pedido pela mensagem cai na
 * barreira de `lib/supabase/server.ts`, que falha alto em toda página protegida;
 * e o 503 do backend segue valendo para qualquer chamada que chegue lá. */
export async function requireSupabaseToken(getToken: GetToken): Promise<string> {
  const token = await getToken();
  if (!token) throw new MissingAuthTokenError();
  if (!lacksSupabaseUid(token)) return token;

  const fresh = await getToken({ skipCache: true });
  if (!fresh) throw new MissingAuthTokenError();
  if (lacksSupabaseUid(fresh)) {
    console.error(
      "[api] session token sem `supabase_uid` mesmo após reemissão: vínculo " +
        "pendente ou custom claims ausentes na instância Clerk",
    );
    throw new AccessLinkPendingError();
  }
  return fresh;
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
    const body: unknown = await res.json().catch(() => null);
    throw new ApiError(apiErrorCopy(path, res.status, res.statusText, body), res.status);
  }

  return res.json();
}

/**
 * Acorda a API sem esperar a resposta. A API fica pausada no Fly quando ninguém
 * a usa; chamar isto quando alguém abre a GUI faz a retomada acontecer enquanto
 * a pessoa navega, e não no clique em "Executar". `/health` é público e não
 * toca o banco. A falha é ignorada: aquecer é otimização, não requisito.
 */
export function warmUpApi(): void {
  void fetch(`${API_URL}/health`, { cache: "no-store" }).catch(() => {});
}
