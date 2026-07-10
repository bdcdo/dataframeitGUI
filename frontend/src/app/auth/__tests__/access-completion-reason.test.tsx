// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// T013: classificação de motivo na tela de conclusão. Cobre os motivos que a
// tela apresenta (link-pending, link-divergent, sync-temporary-failure,
// unknown-recoverable) e a transição de motivo quando o retry não resolve — sem
// mandar o usuário de volta ao login (contracts/access-completion "Rejected
// behavior"). O motivo `no-project-access` é distinto por design: é decidido no
// dashboard (estado "Nenhum projeto ainda"), não nesta tela — ver
// dashboard/page.tsx e o teste de fail-closed do resolver.

const replace = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh }),
}));

const completeAccess = vi.fn();
vi.mock("@/actions/complete-access", () => ({
  completeAccess: () => completeAccess(),
}));

import { AccessCompletionCard } from "@/components/auth/AccessCompletionCard";

afterEach(cleanup);
beforeEach(() => {
  replace.mockClear();
  refresh.mockClear();
  completeAccess.mockReset();
});

describe("AccessCompletionCard — motivos apresentados", () => {
  it.each([
    ["link-pending", /preparando seu acesso/i],
    ["link-divergent", /confirmar sua conta/i],
    ["sync-temporary-failure", /instabilidade temporária/i],
    ["unknown-recoverable", /não foi possível concluir/i],
  ] as const)("motivo %s mostra a mensagem correta", (reason, matcher) => {
    render(
      <AccessCompletionCard
        reason={reason}
        actorEmail="ana@exemplo.com"
        nextUrl="/dashboard"
      />,
    );
    // Alguns motivos repetem a expressão em título e descrição; basta ao menos
    // uma ocorrência da mensagem correta.
    expect(screen.getAllByText(matcher).length).toBeGreaterThanOrEqual(1);
  });

  it("retry bem-sucedido redireciona ao destino pretendido", async () => {
    completeAccess.mockResolvedValue({ ok: true });
    render(
      <AccessCompletionCard
        reason="link-pending"
        actorEmail="ana@exemplo.com"
        nextUrl="/projects/abc"
      />,
    );
    await userEvent.click(screen.getByRole("button"));
    expect(replace).toHaveBeenCalledWith("/projects/abc");
  });

  it("retry que falha atualiza o motivo, sem voltar ao login", async () => {
    completeAccess.mockResolvedValue({
      ok: false,
      reason: "unknown-recoverable",
    });
    render(
      <AccessCompletionCard
        reason="link-pending"
        actorEmail="ana@exemplo.com"
        nextUrl="/dashboard"
      />,
    );
    await userEvent.click(screen.getByRole("button"));
    // Passa a mostrar o estado recuperável; nunca chamou replace("/auth/login").
    expect(await screen.findByText(/não foi possível concluir/i)).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });
});
