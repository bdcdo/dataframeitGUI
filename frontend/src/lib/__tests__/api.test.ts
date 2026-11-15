/**
 * Contrato real de `lib/api.ts` (#348).
 *
 * Até aqui estes dois helpers nunca tinham rodado em teste: os testes de
 * `RunLlmButton` e `useLlmRunProgress` mockam `@/lib/api` com uma réplica manual
 * de `requireSupabaseToken` ("Réplica do real: ..."). Réplica não é contrato — se
 * o original mudar, o mock segue verde e o drift passa. Estes testes exercitam o
 * código de produção, e é assim que a precedência de headers apareceu quebrada.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchFastAPI, requireSupabaseToken } from "../api";

const fetchMock = vi.fn();

/** Init do último `fetch`, já tipado como o objeto plano que o helper monta. */
function lastInit(): RequestInit & { headers: Record<string, string> } {
  return fetchMock.mock.calls.at(-1)![1];
}

function okResponse(body: unknown = { ok: true }) {
  return { ok: true, json: async () => body };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(okResponse());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requireSupabaseToken", () => {
  it("pede o token SEM argumento (nunca um JWT template)", async () => {
    // A invariante do #348 no caminho client. `toHaveBeenCalled()` sozinho
    // aceitaria a volta de `{ template: "supabase" }` — por isso a asserção é
    // sobre a lista de argumentos, que precisa estar vazia.
    const getToken = vi.fn().mockResolvedValue("tok");
    await requireSupabaseToken(getToken);
    expect(getToken.mock.calls[0]).toEqual([]);
  });

  it("devolve o token quando a sessão existe", async () => {
    await expect(
      requireSupabaseToken(vi.fn().mockResolvedValue("tok")),
    ).resolves.toBe("tok");
  });

  it("falha fechado quando o token vem nulo, com causa nomeada", async () => {
    // Falhar aqui (antes do request sair) é o que dá ao caller uma causa
    // acionável em vez de um "API error: 401" genérico vindo do backend.
    await expect(
      requireSupabaseToken(vi.fn().mockResolvedValue(null)),
    ).rejects.toMatchObject({ name: "MissingAuthTokenError" });
  });

  it("a mensagem de erro não menciona mais o template legado", async () => {
    // O template saiu no #348: instruir o usuário a conferi-lo mandaria o
    // suporte investigar uma configuração que já não existe.
    await expect(
      requireSupabaseToken(vi.fn().mockResolvedValue(null)),
    ).rejects.toThrow(/^(?!.*template).*$/i);
  });
});

describe("fetchFastAPI", () => {
  it("manda Authorization: Bearer quando recebe token", async () => {
    await fetchFastAPI("/api/llm/run", { method: "POST" }, "tok");
    expect(lastInit().headers.Authorization).toBe("Bearer tok");
  });

  it("não inventa Authorization quando não há token", async () => {
    await fetchFastAPI("/api/llm/run");
    expect(lastInit().headers).not.toHaveProperty("Authorization");
  });

  it("preserva os headers do caller SEM perder Content-Type nem Authorization", async () => {
    // O par crítico: `...options` precisa vir antes da chave `headers`, porque
    // spread de objeto substitui a chave inteira em vez de fazer merge. Na ordem
    // inversa (como o arquivo estava), qualquer `options.headers` apagava o
    // Authorization montado aqui e o request saía sem token — silenciosamente.
    await fetchFastAPI(
      "/api/llm/run",
      { method: "POST", headers: { "X-Custom": "1" } },
      "tok",
    );
    expect(lastInit().headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Custom": "1",
      Authorization: "Bearer tok",
    });
  });

  it("preserva method e body do caller", async () => {
    // Invariante inversa da anterior: sozinha, cada uma admite uma "correção"
    // que quebra a outra (headers comendo options, ou options comendo headers).
    // Juntas, fixam a ordem do spread nos dois sentidos.
    await fetchFastAPI(
      "/api/llm/run",
      { method: "POST", body: JSON.stringify({ a: 1 }) },
      "tok",
    );
    expect(lastInit()).toMatchObject({
      method: "POST",
      body: JSON.stringify({ a: 1 }),
    });
  });

  it("propaga o `detail` do backend como mensagem de erro", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      statusText: "Unprocessable Entity",
      json: async () => ({ detail: "project_id inválido" }),
    });
    // O status vai junto: o caller separa o 4xx (copy para o usuário) do 5xx.
    await expect(fetchFastAPI("/api/llm/run")).rejects.toMatchObject({
      name: "ApiError",
      status: 422,
      message: "project_id inválido",
    });
  });

  it("corpo que não é JSON vira copy pt-BR com o status, e o statusText vai ao log", async () => {
    // 502 de proxy costuma devolver HTML: sem o catch, o `res.json()` lançaria
    // um SyntaxError cru no lugar da causa real. O statusText ("Bad Gateway")
    // é inglês de protocolo e ia direto ao toast.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    });
    await expect(fetchFastAPI("/api/llm/run")).rejects.toMatchObject({
      name: "ApiError",
      status: 502,
      message: "Erro no servidor (HTTP 502). Tente novamente.",
    });
    expect(consoleError).toHaveBeenCalledWith(
      "[api] /api/llm/run falhou",
      expect.objectContaining({ code: "502", message: "Bad Gateway" }),
    );
    consoleError.mockRestore();
  });

  // O 422 de validação do FastAPI traz `detail` como LISTA de objetos: repassada
  // ao `new Error`, virava "[object Object]" no toast.
  it("detail que não é string vira copy pt-BR, e o detail vai ao log", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const detail = [{ loc: ["body", "project_id"], msg: "Field required", type: "missing" }];
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      statusText: "Unprocessable Entity",
      json: async () => ({ detail }),
    });
    await expect(fetchFastAPI("/api/llm/run")).rejects.toMatchObject({
      name: "ApiError",
      status: 422,
      message: "O servidor recusou a requisição (HTTP 422).",
    });
    expect(consoleError).toHaveBeenCalledWith(
      "[api] /api/llm/run falhou",
      expect.objectContaining({ code: "422", message: JSON.stringify(detail) }),
    );
    consoleError.mockRestore();
  });

  // O backend colapsa todo 500 em "Internal Server Error" (main.py), que não é
  // copy para o usuário; os 503 da autenticação trazem copy pt-BR acionável.
  it("500 vira copy pt-BR; 503 mantém o detail do backend", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => ({ detail: "Internal Server Error" }),
    });
    await expect(fetchFastAPI("/api/llm/run")).rejects.toThrow(
      "Erro no servidor (HTTP 500). Tente novamente.",
    );
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      json: async () => ({ detail: "Não foi possível verificar autorização" }),
    });
    await expect(fetchFastAPI("/api/llm/run")).rejects.toThrow(
      "Não foi possível verificar autorização",
    );
    consoleError.mockRestore();
  });

  it("devolve o JSON da resposta", async () => {
    fetchMock.mockResolvedValue(okResponse({ job_id: "j1" }));
    await expect(fetchFastAPI("/api/llm/run")).resolves.toEqual({
      job_id: "j1",
    });
  });
});
