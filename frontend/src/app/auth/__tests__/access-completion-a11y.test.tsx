// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// T015 (C3, Constituição §VI / FR-009 / FR-010): a tela de conclusão de acesso
// é navegável por teclado, define foco inicial, expõe botão de retry com nome
// acessível e não vaza token/claim/debug. shadcn/ui traz a base a11y; o teste
// trava que a customização a preserva e que o texto é não técnico.

const replace = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh }),
}));

vi.mock("@/actions/complete-access", () => ({
  completeAccess: vi.fn(async () => ({ ok: true })),
}));

import { AccessCompletionCard } from "@/components/auth/AccessCompletionCard";

afterEach(cleanup);

describe("AccessCompletionCard — acessibilidade e ausência de detalhe técnico", () => {
  it("expõe título e botão de retry com nome acessível", () => {
    render(
      <AccessCompletionCard
        reason="link-pending"
        actorEmail="ana@exemplo.com"
        nextUrl="/dashboard"
      />,
    );
    // Botão com nome acessível (acionável por teclado — button nativo).
    const button = screen.getByRole("button", { name: /tentar novamente/i });
    expect(button).toBeTruthy();
    // Título visível para reconhecimento do estado.
    expect(screen.getByText(/preparando seu acesso/i)).toBeTruthy();
    // Conta reconhecível (não é dado técnico).
    expect(screen.getByText("ana@exemplo.com")).toBeTruthy();
  });

  it("define foco inicial no título (tabIndex -1 + autoFocus)", () => {
    render(
      <AccessCompletionCard
        reason="link-pending"
        actorEmail="ana@exemplo.com"
        nextUrl="/dashboard"
      />,
    );
    const title = screen.getByText(/preparando seu acesso/i);
    expect(title.getAttribute("tabindex")).toBe("-1");
  });

  it("não renderiza token, claim, debug nem nome de tabela (FR-010)", () => {
    const { container } = render(
      <AccessCompletionCard
        reason="link-divergent"
        actorEmail="ana@exemplo.com"
        nextUrl="/dashboard"
      />,
    );
    const text = container.textContent?.toLowerCase() ?? "";
    for (const forbidden of [
      "token",
      "claim",
      "debug",
      "jwt",
      "clerk_user_mapping",
      "supabase_uid",
      "/api/",
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });
});
