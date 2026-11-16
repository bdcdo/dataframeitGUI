/**
 * Contrato de `fetchFastAPIServer` (#348) — o caminho server, até aqui sem
 * cobertura nenhuma.
 *
 * `server-only` está aliasado para o `empty.js` do próprio pacote no
 * `vitest.config.ts`, então o módulo carrega sem o transform do Next.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  LINKED_CLAIMS,
  UNLINKED_CLAIMS,
  sessionTokenWith,
} from "@/test-utils/session-token";

const { getToken, currentUser, fetchFastAPI } = vi.hoisted(() => ({
  getToken: vi.fn(),
  currentUser: vi.fn(),
  fetchFastAPI: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ getToken }),
  currentUser,
}));
// Só a fronteira de rede é dublê: o erro e a leitura do claim são os reais.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchFastAPI,
}));

const { fetchFastAPIServer } = await import("../api-server");

beforeEach(() => {
  getToken.mockReset().mockResolvedValue("tok");
  fetchFastAPI.mockReset().mockResolvedValue({ ok: true });
  currentUser.mockReset().mockResolvedValue({ publicMetadata: {} });
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

// #532: o mesmo token sem `supabase_uid` é dois estados diferentes, e só a
// metadata da conta os separa.
describe("fetchFastAPIServer — token sem o vínculo (supabase_uid)", () => {
  const unlinked = sessionTokenWith(UNLINKED_CLAIMS);

  it("sessão válida, metadata sem supabase_uid: o request não sai", async () => {
    getToken.mockResolvedValue(unlinked);
    currentUser.mockResolvedValue({ publicMetadata: {} });

    await expect(
      fetchFastAPIServer("/api/pydantic/recover-fields"),
    ).rejects.toMatchObject({
      name: "AccessLinkPendingError",
      message:
        "Seu acesso ainda não foi concluído. Recarregue a página para concluir o acesso.",
    });
    expect(fetchFastAPI).not.toHaveBeenCalled();
  });

  it("metadata COM supabase_uid: segue para o backend, que falha alto (#487)", async () => {
    // Instância Clerk sem os custom claims: a conta tem o vínculo e só o token
    // não o carrega. Barrar aqui com "conclua o acesso" esconderia a config
    // quebrada atrás de uma instrução que não resolve; o 503 do backend é a
    // resposta certa e não pode ser interceptado.
    getToken.mockResolvedValue(unlinked);
    currentUser.mockResolvedValue({
      publicMetadata: { supabase_uid: LINKED_CLAIMS.supabase_uid },
    });

    await fetchFastAPIServer("/api/pydantic/recover-fields");
    expect(fetchFastAPI.mock.calls[0][2]).toBe(unlinked);
  });

  it("token com o claim não consulta a conta no Clerk", async () => {
    getToken.mockResolvedValue(sessionTokenWith(LINKED_CLAIMS));
    await fetchFastAPIServer("/api/pydantic/recover-fields");
    expect(currentUser).not.toHaveBeenCalled();
    expect(fetchFastAPI).toHaveBeenCalled();
  });
});
