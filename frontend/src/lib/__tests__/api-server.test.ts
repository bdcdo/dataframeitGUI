/**
 * Contrato de `fetchFastAPIServer` (#348) — o caminho server, até aqui sem
 * cobertura nenhuma.
 *
 * `server-only` está aliasado para o `empty.js` do próprio pacote no
 * `vitest.config.ts`, então o módulo carrega sem o transform do Next.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getToken, fetchFastAPI } = vi.hoisted(() => ({
  getToken: vi.fn(),
  fetchFastAPI: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ getToken }) }));
vi.mock("@/lib/api", () => ({ fetchFastAPI }));

const { fetchFastAPIServer } = await import("../api-server");

beforeEach(() => {
  getToken.mockReset().mockResolvedValue("tok");
  fetchFastAPI.mockReset().mockResolvedValue({ ok: true });
});

describe("fetchFastAPIServer", () => {
  it("pede o session token SEM argumento (nunca um JWT template)", async () => {
    // Mesma invariante de `requireSupabaseToken`, do outro lado da fronteira:
    // um `{ template: "supabase" }` aqui voltaria a emitir token com `aud`, que
    // o backend — que agora valida `iss` (#487) — não espera mais.
    await fetchFastAPIServer("/api/pydantic/recover-fields");
    expect(getToken.mock.calls[0]).toEqual([]);
  });

  it("repassa path, options e token ao fetchFastAPI", async () => {
    const options = { method: "POST", body: '{"project_id":"p1"}' };
    await fetchFastAPIServer("/api/pydantic/recover-fields", options);
    expect(fetchFastAPI).toHaveBeenCalledWith(
      "/api/pydantic/recover-fields",
      options,
      "tok",
    );
  });

  it("token ausente vira `undefined`, nunca `null`", async () => {
    // É o `token ?? undefined` do arquivo. Sem ele, o `null` chegaria ao
    // `fetchFastAPI` como valor falsy — hoje inofensivo, mas qualquer helper que
    // passasse a interpolar o argumento mandaria um `Bearer null` para o
    // backend, que responderia 401 sem dizer que a sessão é que faltava.
    getToken.mockResolvedValue(null);
    await fetchFastAPIServer("/api/llm/cleanup-stale");
    expect(fetchFastAPI.mock.calls[0][2]).toBeUndefined();
  });

  it("devolve o resultado do fetchFastAPI ao caller", async () => {
    fetchFastAPI.mockResolvedValue({ cleaned: 3 });
    await expect(fetchFastAPIServer("/api/llm/cleanup-stale")).resolves.toEqual({
      cleaned: 3,
    });
  });
});
