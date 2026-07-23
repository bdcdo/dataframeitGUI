import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  resolution: {} as Record<string, unknown>,
  pathname: null as string | null,
  redirects: [] as string[],
}));

vi.mock("@/lib/auth", () => ({
  resolveAuth: async () => state.resolution,
}));

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name: string) => (name === "x-pathname" ? state.pathname : null),
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (destination: string) => {
    state.redirects.push(destination);
    throw new Error(`REDIRECT:${destination}`);
  },
}));

beforeEach(() => {
  state.pathname = null;
  state.redirects = [];
});

describe("requirePageAuthUser", () => {
  it("devolve a identidade pronta sem redirecionar", async () => {
    const user = {
      id: "supabase-user",
      email: "user@example.com",
      firstName: "User",
      lastName: null,
      clerkId: "clerk-user",
      isMaster: false,
    };
    state.resolution = { status: "authenticated", user };
    const { requirePageAuthUser } = await import("@/lib/page-auth");

    await expect(requirePageAuthUser()).resolves.toBe(user);
    expect(state.redirects).toEqual([]);
  });

  it("envia apenas ausência real de sessão ao login", async () => {
    state.resolution = { status: "signed-out" };
    const { requirePageAuthUser } = await import("@/lib/page-auth");

    await expect(requirePageAuthUser()).rejects.toThrow(
      "REDIRECT:/auth/login",
    );
    expect(state.redirects).toEqual(["/auth/login"]);
  });

  it.each([
    { status: "access-completion-required", reason: "link-pending" },
    { status: "access-completion-required", reason: "link-divergent" },
    { status: "technical-sync-failure", reason: "sync-temporary-failure" },
  ])("preserva $status/$reason na rota de conclusão", async (resolution) => {
    state.resolution = resolution;
    state.pathname = "/projects/project-1/analyze/code?round=current";
    const { requirePageAuthUser } = await import("@/lib/page-auth");

    await expect(requirePageAuthUser()).rejects.toThrow(
      "REDIRECT:/auth/post-login?next=%2Fprojects%2Fproject-1%2Fanalyze%2Fcode%3Fround%3Dcurrent",
    );
    expect(state.redirects).toEqual([
      "/auth/post-login?next=%2Fprojects%2Fproject-1%2Fanalyze%2Fcode%3Fround%3Dcurrent",
    ]);
  });

  it("usa a conclusão sem next quando o pathname não está disponível", async () => {
    state.resolution = {
      status: "technical-sync-failure",
      reason: "sync-temporary-failure",
    };
    const { requirePageAuthUser } = await import("@/lib/page-auth");

    await expect(requirePageAuthUser()).rejects.toThrow(
      "REDIRECT:/auth/post-login",
    );
    expect(state.redirects).toEqual(["/auth/post-login"]);
  });
});
