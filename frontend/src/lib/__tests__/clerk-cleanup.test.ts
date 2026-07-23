import type { Page } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";

const { signOut } = vi.hoisted(() => ({ signOut: vi.fn() }));

vi.mock("@clerk/testing/playwright", () => ({
  clerk: { signOut },
}));

import { withClerkCleanup } from "../../../e2e/clerk-cleanup";

const page = {} as Page;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  signOut.mockReset();
});

describe("withClerkCleanup", () => {
  it("encerra a sessão depois do corpo do teste", async () => {
    signOut.mockResolvedValue(undefined);

    await expect(
      withClerkCleanup({
        page,
        context: "test",
        run: async () => "result",
      }),
    ).resolves.toBe("result");
    expect(signOut).toHaveBeenCalledWith({ page });
  });

  it("considera Session not found um cleanup já concluído", async () => {
    signOut.mockRejectedValue({
      errors: [{ code: "resource_not_found", message: "Session not found" }],
    });

    await expect(
      withClerkCleanup({
        page,
        context: "test",
        run: async () => undefined,
      }),
    ).resolves.toBeUndefined();
  });

  it("tenta encerrar a sessão mesmo quando a preparação falha", async () => {
    const prepareError = new Error("falha ao preparar");
    signOut.mockResolvedValue(undefined);

    await expect(
      withClerkCleanup({
        page,
        context: "lottery",
        run: async () => undefined,
        prepareSignOut: async () => {
          throw prepareError;
        },
      }),
    ).rejects.toBe(prepareError);
    expect(signOut).toHaveBeenCalledWith({ page });
  });

  it("falha com contexto quando o sign-out ultrapassa 5s", async () => {
    vi.useFakeTimers();
    signOut.mockImplementation(() => new Promise(() => undefined));

    const cleanup = withClerkCleanup({
      page,
      context: "config-guard",
      run: async () => undefined,
    });
    const assertion = expect(cleanup).rejects.toThrow(
      "clerk.signOut não concluiu em 5s durante cleanup (config-guard)",
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
    signOut.mockRejectedValue(cleanupError);

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
