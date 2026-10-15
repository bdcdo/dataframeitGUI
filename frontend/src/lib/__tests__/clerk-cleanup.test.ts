import type { Page } from "@playwright/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { revokeSession, getSession } = vi.hoisted(() => ({
  revokeSession: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({ sessions: { revokeSession, getSession } }),
}));

import { withClerkCleanup } from "../../../e2e/clerk-cleanup";

const SESSION_ID = "sess_doTeste";

function jwtWith(payload: object): string {
  const part = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part(payload)}.assinatura`;
}

function pageWithCookies(cookies: Array<{ name: string; value: string }>) {
  return {
    context: () => ({ cookies: async () => cookies }),
  } as unknown as Page;
}

// O Clerk grava o mesmo `sid` em `__session` e numa cópia com sufixo; a cópia
// leva outro `sid` aqui só para provar que o helper lê o cookie certo.
const page = pageWithCookies([
  { name: "__session_7n2HGTaO", value: jwtWith({ sid: "sess_outra" }) },
  { name: "__session", value: jwtWith({ sid: SESSION_ID }) },
]);

beforeEach(() => {
  vi.stubEnv("CLERK_SECRET_KEY", "sk_test_cleanup");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  revokeSession.mockReset();
  getSession.mockReset();
});

describe("withClerkCleanup", () => {
  it("revoga a sessão do cookie __session depois do corpo do teste", async () => {
    revokeSession.mockResolvedValue({ status: "revoked" });

    await expect(
      withClerkCleanup({ page, context: "test", run: async () => "result" }),
    ).resolves.toBe("result");
    expect(revokeSession).toHaveBeenCalledTimes(1);
    expect(revokeSession).toHaveBeenCalledWith(SESSION_ID);
  });

  it("considera concluído o cleanup de sessão que já não está ativa", async () => {
    revokeSession.mockRejectedValue(new Error("session not active"));
    getSession.mockResolvedValue({ status: "revoked" });

    await expect(
      withClerkCleanup({ page, context: "test", run: async () => undefined }),
    ).resolves.toBeUndefined();
  });

  it("considera concluído o cleanup de sessão que o Clerk não encontra", async () => {
    revokeSession.mockRejectedValue({ status: 404 });
    getSession.mockRejectedValue({ status: 404 });

    await expect(
      withClerkCleanup({ page, context: "test", run: async () => undefined }),
    ).resolves.toBeUndefined();
  });

  it("repassa o erro quando a sessão continua ativa", async () => {
    const revokeError = new Error("falha ao revogar");
    revokeSession.mockRejectedValue(revokeError);
    getSession.mockResolvedValue({ status: "active" });

    await expect(
      withClerkCleanup({ page, context: "test", run: async () => undefined }),
    ).rejects.toBe(revokeError);
  });

  it("repassa o erro quando nem a consulta de status responde", async () => {
    const revokeError = new Error("fetch failed");
    revokeSession.mockRejectedValue(revokeError);
    getSession.mockRejectedValue(new Error("fetch failed"));

    await expect(
      withClerkCleanup({ page, context: "test", run: async () => undefined }),
    ).rejects.toBe(revokeError);
  });

  it("falha com contexto quando não há sessão no cookie", async () => {
    await expect(
      withClerkCleanup({
        page: pageWithCookies([]),
        context: "lottery",
        run: async () => undefined,
      }),
    ).rejects.toThrow("cookie __session sem id de sessão durante cleanup (lottery)");
    expect(revokeSession).not.toHaveBeenCalled();
  });

  it("falha com contexto quando a revogação ultrapassa 5s", async () => {
    vi.useFakeTimers();
    revokeSession.mockImplementation(() => new Promise(() => undefined));

    const cleanup = withClerkCleanup({
      page,
      context: "config-guard",
      run: async () => undefined,
    });
    const assertion = expect(cleanup).rejects.toThrow(
      "revogação da sessão Clerk não concluiu em 5s durante cleanup (config-guard)",
    );

    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it("preserva o erro principal quando o cleanup também falha", async () => {
    const primaryError = new Error("falha principal");
    const cleanupError = new Error("falha de cleanup");
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    revokeSession.mockRejectedValue(cleanupError);
    getSession.mockResolvedValue({ status: "active" });

    await expect(
      withClerkCleanup({
        page,
        context: "test",
        run: async () => {
          throw primaryError;
        },
      }),
    ).rejects.toBe(primaryError);
    expect(warning).toHaveBeenCalledWith(
      "Cleanup Clerk falhou após erro anterior do teste (test):",
      cleanupError,
    );
  });
});
