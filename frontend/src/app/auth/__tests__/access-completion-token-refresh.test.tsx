// @vitest-environment jsdom
/**
 * #348: o retry da conclusão de acesso renova o token ANTES de navegar — e a
 * renovação é best-effort, não um portão.
 *
 * `completeAccess` grava o `supabase_uid` na metadata do Clerk, mas o token em
 * cache no cliente foi emitido antes disso. `skipCache: true` força uma nova
 * emissão; o `template` saiu no #348, então a chamada não pode mais carregá-lo
 * (voltaria a emitir um token com `aud` e sem os custom claims).
 *
 * A política de NÃO bloquear vem do #440 e é deliberada: o vínculo já está
 * gravado neste ponto e a página de destino minta o próprio token no servidor
 * (lib/supabase/server.ts). Quem depende deste cache é só o cliente ao chamar o
 * FastAPI. Barrar a navegação por um blip anunciaria falha sobre um acesso
 * concluído.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const calls: string[] = [];

const replace = vi.fn(() => void calls.push("replace"));
const refresh = vi.fn(() => void calls.push("refresh"));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh }),
}));

/** Espelha a assinatura real do `getToken` do Clerk. O parâmetro é declarado
 * (mesmo sem uso) para que as asserções possam inspecionar `mock.calls[0][0]` —
 * é justamente o argumento que este teste existe para vigiar. */
const getToken = vi.fn(
  async (_opts?: {
    skipCache?: boolean;
    template?: string;
  }): Promise<string | null> => {
    calls.push("getToken");
    return "tok";
  },
);
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken }) }));

const completeAccess = vi.fn();
vi.mock("@/actions/complete-access", () => ({
  completeAccess: () => completeAccess(),
}));

import { AccessCompletionCard } from "@/components/auth/AccessCompletionCard";

afterEach(cleanup);
beforeEach(() => {
  calls.length = 0;
  replace.mockClear();
  refresh.mockClear();
  getToken.mockReset().mockImplementation(async () => {
    calls.push("getToken");
    return "tok";
  });
  completeAccess.mockReset().mockResolvedValue({ ok: true });
});

function renderCard() {
  render(
    <AccessCompletionCard
      reason="link-pending"
      actorEmail="ana@exemplo.com"
      nextUrl="/dashboard"
    />,
  );
}

describe("AccessCompletionCard — renovação do token no retry bem-sucedido", () => {
  it("renova com `skipCache` e SEM `template`", async () => {
    // As duas metades importam. `skipCache` é o que faz o Clerk reemitir em vez
    // de servir o token pré-`completeAccess`; a ausência de `template` é a
    // invariante do #348 — um `{ template: "supabase" }` aqui voltaria a emitir
    // token com `aud` e sem `supabase_uid`/`role`.
    renderCard();
    await userEvent.click(screen.getByRole("button", { name: /tentar/i }));

    await waitFor(() => expect(getToken).toHaveBeenCalled());
    expect(getToken).toHaveBeenCalledWith({ skipCache: true });
    expect(getToken.mock.calls[0][0]).not.toHaveProperty("template");
  });

  it("espera a renovação terminar antes de navegar", async () => {
    // Segura a renovação em aberto: enquanto ela não resolve, nenhuma navegação
    // pode ter acontecido. É o que distingue `await getToken(...)` de um
    // `void getToken(...)` — este último dispara na ordem certa mas navega com
    // o token velho mesmo assim, e passaria por uma asserção só de ordem.
    let liberaToken: () => void = () => {};
    getToken.mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          calls.push("getToken");
          liberaToken = () => resolve("tok");
        }),
    );

    renderCard();
    await userEvent.click(screen.getByRole("button", { name: /tentar/i }));

    await waitFor(() => expect(getToken).toHaveBeenCalled());
    expect(replace).not.toHaveBeenCalled();

    liberaToken();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/dashboard"));
    expect(calls).toEqual(["getToken", "replace", "refresh"]);
  });

  it("NAVEGA mesmo quando a renovação falha (best-effort, não portão)", async () => {
    // O vínculo já está gravado e a página de destino minta o próprio token no
    // servidor. Prender a pessoa aqui por um blip de rede anunciaria falha sobre
    // um acesso concluído — a decisão do #440, que este teste protege de ser
    // silenciosamente revertida.
    getToken.mockRejectedValue(new Error("network"));
    renderCard();
    await userEvent.click(screen.getByRole("button", { name: /tentar/i }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/dashboard"));
    expect(refresh).toHaveBeenCalled();
  });

  it("retry que não resolve o vínculo nem tenta renovar o token", async () => {
    // Sem vínculo novo não há claim novo para buscar: a renovação só faz sentido
    // depois de `completeAccess` ter gravado a metadata.
    completeAccess.mockResolvedValue({
      ok: false,
      reason: "unknown-recoverable",
    });
    renderCard();
    await userEvent.click(screen.getByRole("button", { name: /tentar/i }));

    await waitFor(() =>
      expect(screen.getByText(/não conseguimos concluir/i)).toBeDefined(),
    );
    expect(getToken).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});
