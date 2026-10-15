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

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function jwtWith(payload: unknown): string {
  return `${base64url({ alg: "RS256" })}.${base64url(payload)}.assinatura`;
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

/** Formato do `ClerkAPIResponseError`: `status` HTTP e a causa em `errors[]`. */
function clerkError(status: number | undefined, code: string, message = "") {
  return Object.assign(new Error(message), {
    status,
    errors: [{ code, message: code }],
  });
}

const notFound = () => clerkError(404, "resource_not_found");
const networkFailure = () => clerkError(undefined, "unexpected_error");

function cleanup(context = "test", target: Page = page) {
  return withClerkCleanup({ page: target, context, run: async () => undefined });
}

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

  it.each(["abandoned", "ended", "expired", "removed", "replaced", "revoked"])(
    "considera concluído o cleanup de sessão já %s",
    async (status) => {
      revokeSession.mockRejectedValue(new Error("session not active"));
      getSession.mockResolvedValue({ status });

      await expect(cleanup()).resolves.toBeUndefined();
    },
  );

  it.each(["active", "pending"])(
    "repassa o erro com contexto quando a sessão continua %s",
    async (status) => {
      const revokeError = new Error("falha ao revogar");
      revokeSession.mockRejectedValue(revokeError);
      getSession.mockResolvedValue({ status });

      const error = await cleanup("lottery").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "revogação da sessão Clerk falhou durante cleanup (lottery): falha ao revogar",
      );
      expect((error as Error).cause).toBe(revokeError);
    },
  );

  it("considera concluído quando a revogação dá 404, mesmo sem consulta", async () => {
    revokeSession.mockRejectedValue(notFound());
    getSession.mockRejectedValue(networkFailure());

    await expect(cleanup()).resolves.toBeUndefined();
  });

  it("considera concluído quando a consulta dá 404 depois de falha de rede", async () => {
    revokeSession.mockRejectedValue(networkFailure());
    getSession.mockRejectedValue(notFound());

    await expect(cleanup()).resolves.toBeUndefined();
  });

  it("não trata outro 4xx como sessão inexistente", async () => {
    revokeSession.mockRejectedValue(clerkError(429, "too_many_requests", "Too Many Requests"));
    getSession.mockRejectedValue(clerkError(429, "too_many_requests", "Too Many Requests"));

    await expect(cleanup("export")).rejects.toThrow(
      "revogação da sessão Clerk falhou durante cleanup (export): HTTP 429 | Too Many Requests | too_many_requests: too_many_requests",
    );
  });

  it("dá a causa da falha de rede, que o Clerk entrega com mensagem vazia", async () => {
    revokeSession.mockRejectedValue(networkFailure());
    getSession.mockRejectedValue(networkFailure());

    await expect(cleanup("coding-save")).rejects.toThrow(
      "revogação da sessão Clerk falhou durante cleanup (coding-save): unexpected_error: unexpected_error",
    );
  });

  it.each([
    ["sem cookie", []],
    ["com JWT de payload ilegível", [{ name: "__session", value: "a.!!!.b" }]],
    ["com payload nulo", [{ name: "__session", value: `a.${base64url(null)}.b` }]],
    ["com sid fora do formato", [{ name: "__session", value: jwtWith({ sid: "user_x" }) }]],
  ])("falha com contexto %s", async (_, cookies) => {
    await expect(cleanup("lottery", pageWithCookies(cookies))).rejects.toThrow(
      "cookie __session sem id de sessão durante cleanup (lottery)",
    );
    expect(revokeSession).not.toHaveBeenCalled();
  });

  it("falha com contexto sem CLERK_SECRET_KEY", async () => {
    vi.stubEnv("CLERK_SECRET_KEY", "");

    await expect(cleanup("dashboard")).rejects.toThrow(
      "revogação da sessão Clerk falhou durante cleanup (dashboard): CLERK_SECRET_KEY ausente",
    );
    expect(revokeSession).not.toHaveBeenCalled();
  });

  it("falha com contexto quando a revogação ultrapassa 5s", async () => {
    vi.useFakeTimers();
    revokeSession.mockImplementation(() => new Promise(() => undefined));

    const pending = cleanup("config-guard");
    const assertion = expect(pending).rejects.toThrow(
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
    expect(warning).toHaveBeenCalledTimes(1);
    const [label, reported] = warning.mock.calls[0] as [string, Error];
    expect(label).toBe("Cleanup Clerk falhou após erro anterior do teste (test):");
    expect(reported.cause).toBe(cleanupError);
  });
});
