import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthUser: vi.fn(),
  getProjectAccessContext: vi.fn(),
  redirect: vi.fn((path: string): never => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));

vi.mock("@/lib/auth", () => ({
  getAuthUser: mocks.getAuthUser,
  getProjectAccessContext: mocks.getProjectAccessContext,
}));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(),
  redirect: mocks.redirect,
}));

import LlmLayout from "@/app/(app)/projects/[id]/llm/layout";
import LlmInsightsLayout from "@/app/(app)/projects/[id]/reviews/llm-insights/layout";

const originalValue = process.env.NEXT_PUBLIC_LLM_ENABLED;

afterEach(() => {
  vi.clearAllMocks();
  if (originalValue === undefined) {
    delete process.env.NEXT_PUBLIC_LLM_ENABLED;
  } else {
    process.env.NEXT_PUBLIC_LLM_ENABLED = originalValue;
  }
});

describe("layouts das páginas LLM", () => {
  it("redireciona todo /llm/* antes de consultar autenticação", async () => {
    process.env.NEXT_PUBLIC_LLM_ENABLED = "false";

    await expect(
      LlmLayout({
        children: <div>LLM</div>,
        params: Promise.resolve({ id: "p1" }),
      }),
    ).rejects.toThrow("REDIRECT:/projects/p1/analyze/code");
    expect(mocks.getAuthUser).not.toHaveBeenCalled();
  });

  it("redireciona o acesso direto a Erros LLM", async () => {
    process.env.NEXT_PUBLIC_LLM_ENABLED = "false";

    await expect(
      LlmInsightsLayout({
        children: <div>Erros LLM</div>,
        params: Promise.resolve({ id: "p1" }),
      }),
    ).rejects.toThrow("REDIRECT:/projects/p1/analyze/code");
  });
});
