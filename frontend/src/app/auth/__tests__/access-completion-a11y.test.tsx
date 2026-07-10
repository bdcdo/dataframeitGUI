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
    // Título como heading real (anunciado como cabeçalho por AT).
    expect(
      screen.getByRole("heading", { name: /preparando seu acesso/i }),
    ).toBeTruthy();
    // Conta reconhecível (não é dado técnico).
    expect(screen.getByText("ana@exemplo.com")).toBeTruthy();
  });

  it("título é heading focável e recebe o foco inicial (tabIndex -1 + ref)", () => {
    render(
      <AccessCompletionCard
        reason="link-pending"
        actorEmail="ana@exemplo.com"
        nextUrl="/dashboard"
      />,
    );
    const title = screen.getByRole("heading", {
      name: /preparando seu acesso/i,
    });
    // Focável fora da ordem de Tab e foco movido para ele ao montar, para que
    // leitores de tela anunciem o estado de conclusão de acesso.
    expect(title.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(title);
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
