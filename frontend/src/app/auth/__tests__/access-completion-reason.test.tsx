// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
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

const getToken = vi.fn();
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken }),
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
  getToken.mockReset();
  getToken.mockResolvedValue("fresh-supabase-token");
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

  it("renova o JWT Supabase antes de redirecionar ao destino pretendido", async () => {
    completeAccess.mockResolvedValue({ ok: true });
    render(
      <AccessCompletionCard
        reason="link-pending"
        actorEmail="ana@exemplo.com"
        nextUrl="/projects/abc"
      />,
    );
    await userEvent.click(screen.getByRole("button"));

    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    // Sem `template`: o JWT template legado saiu no #348 e o que se renova aqui
    // é o session token. `skipCache` continua sendo o que força a reemissão.
    expect(getToken).toHaveBeenCalledWith({ skipCache: true });
    expect(replace).toHaveBeenCalledWith("/projects/abc");
    expect(completeAccess.mock.invocationCallOrder[0]).toBeLessThan(
      getToken.mock.invocationCallOrder[0],
    );
    expect(getToken.mock.invocationCallOrder[0]).toBeLessThan(
      replace.mock.invocationCallOrder[0],
    );
    expect(replace.mock.invocationCallOrder[0]).toBeLessThan(
      refresh.mock.invocationCallOrder[0],
    );
  });

  // Este caso afirmava o inverso — que a falha de renovação impedia a
  // navegação. Era um falso negativo: quando completeAccess devolve ok, o
  // vínculo JÁ está gravado, e a página de destino é um RSC que minta o próprio
  // token no servidor a cada request (lib/supabase/server.ts). O token do
  // cliente só serve às chamadas ao FastAPI (lib/api.ts), então usá-lo como
  // portão anunciava fracasso sobre um acesso concluído.
  it("navega mesmo se a renovação do token falhar: o acesso já foi concluído", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    completeAccess.mockResolvedValue({ ok: true });
    getToken.mockRejectedValue(new Error("Clerk indisponível"));
    render(
      <AccessCompletionCard
        reason="link-pending"
        actorEmail="ana@exemplo.com"
        nextUrl="/projects/abc"
      />,
    );

    await userEvent.click(screen.getByRole("button"));

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/projects/abc"));
    expect(refresh).toHaveBeenCalled();
    // A renovação continua sendo tentada (aquece o cache que o cliente usa) e a
    // falha vai para o log — só não decide mais a navegação.
    expect(getToken).toHaveBeenCalledWith({ skipCache: true });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("conflito estrutural é terminal: explica e não oferece retry", async () => {
    completeAccess.mockResolvedValue({
      ok: false,
      reason: "identity-conflict",
    });
    render(
      <AccessCompletionCard
        reason="link-pending"
        actorEmail="ana@exemplo.com"
        nextUrl="/projects/abc"
      />,
    );

    await userEvent.click(screen.getByRole("button"));

    expect(
      await screen.findByText(/já está em uso por outra conta/i),
    ).toBeTruthy();
    expect(screen.getByText(/procure o coordenador/i)).toBeTruthy();
    // Sem botão: insistir num conflito estrutural nunca conclui.
    expect(screen.queryByRole("button")).toBeNull();
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
