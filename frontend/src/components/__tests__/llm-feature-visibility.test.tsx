// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  useAuth: vi.fn(() => ({ getToken: vi.fn() })),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/p1/analyze/code",
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: mocks.useAuth }));
vi.mock("@/lib/api", () => ({
  fetchFastAPI: vi.fn(),
  requireSupabaseToken: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { ProjectTabs } from "@/components/shell/ProjectTabs";
import { ReviewsNav } from "@/components/reviews/ReviewsNav";
import { RunLlmButton } from "@/components/shared/RunLlmButton";

const originalValue = process.env.NEXT_PUBLIC_LLM_ENABLED;

beforeEach(() => {
  process.env.NEXT_PUBLIC_LLM_ENABLED = "false";
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  if (originalValue === undefined) {
    delete process.env.NEXT_PUBLIC_LLM_ENABLED;
  } else {
    process.env.NEXT_PUBLIC_LLM_ENABLED = originalValue;
  }
});

describe("superfícies LLM com a feature desligada", () => {
  it("remove a aba principal sem afetar as demais áreas do projeto", () => {
    render(<ProjectTabs projectId="p1" isCoordinator isLlmRunning />);

    expect(screen.queryByRole("link", { name: /LLM/ })).toBeNull();
    expect(screen.getByRole("link", { name: "Analisar" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Configurações" })).toBeTruthy();
  });

  it("remove Erros LLM da navegação de revisão", () => {
    render(<ReviewsNav projectId="p1" />);

    expect(screen.queryByRole("link", { name: "Erros LLM" })).toBeNull();
    expect(screen.getByRole("link", { name: "Gabarito" })).toBeTruthy();
  });

  it("remove o botão compartilhado antes de inicializar a sessão Clerk", () => {
    const { container } = render(
      <RunLlmButton projectId="p1" documentId="d1" canRunLlm />,
    );

    expect(container.firstChild).toBeNull();
    expect(mocks.useAuth).not.toHaveBeenCalled();
  });
});
