// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, type ComponentProps } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";

// O Clerk é fronteira externa: o mock reproduz só o traço que causa o bug, o
// `clerk.loaded` lido ao vivo no render (no `@clerk/react` real, o getter
// `IsomorphicClerk.loaded`). Carregado, emite o mesmo nó que o `SignIn` real
// emite (`data-clerk-component`); não carregado, nada, como no servidor.
const clerkState = vi.hoisted(() => ({ loaded: false }));

vi.mock("@clerk/nextjs", () => ({
  SignIn: (props: { forceRedirectUrl?: string }) =>
    clerkState.loaded ? (
      <div
        data-clerk-component="SignIn"
        data-force-redirect={props.forceRedirectUrl}
      />
    ) : null,
}));

import { SignIn as ClerkSignIn } from "@clerk/nextjs";
import { SignIn } from "../clerk-ui";

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  clerkState.loaded = false;
});

type SignInProps = ComponentProps<typeof SignIn>;

// Renderiza no "servidor" com o Clerk descarregado (sempre o caso lá), depois
// simula o clerk-js terminando de carregar ANTES de a hidratação chegar ao
// componente — a ordem que produz o "Hydration failed" intermitente — e hidrata.
async function hydrateAfterClerkLoaded(
  element: React.ReactElement<SignInProps>,
): Promise<{ container: HTMLElement; recoverable: unknown[] }> {
  const container = document.createElement("div");
  container.innerHTML = renderToString(element);
  document.body.appendChild(container);

  clerkState.loaded = true;

  const recoverable: unknown[] = [];
  await act(async () => {
    root = hydrateRoot(container, element, {
      onRecoverableError: (error) => recoverable.push(error),
    });
  });
  return { container, recoverable };
}

describe("clerk-ui SignIn — portão de hidratação", () => {
  it("controle: sem o portão, o Clerk carregado antes da hidratação quebra a hidratação", async () => {
    // Prova de que o mock reproduz o mecanismo. Se este teste deixar de falhar
    // a hidratação, o teste de baixo vira vácuo e precisa ser revisto.
    const silence = vi.spyOn(console, "error").mockImplementation(() => {});
    const { recoverable } = await hydrateAfterClerkLoaded(
      <ClerkSignIn forceRedirectUrl="/auth/post-login" />,
    );
    silence.mockRestore();

    expect(recoverable.map(String).join("\n")).toMatch(/Hydration failed/);
  });

  it("com o portão, hidrata sem divergência e monta o SignIn logo depois", async () => {
    const { container, recoverable } = await hydrateAfterClerkLoaded(
      <SignIn forceRedirectUrl="/auth/post-login" />,
    );

    expect(recoverable).toEqual([]);
    const node = container.querySelector('[data-clerk-component="SignIn"]');
    expect(node, "o SignIn não montou depois da hidratação").not.toBeNull();
    // As props chegam ao componente do Clerk sem perda.
    expect(node!.getAttribute("data-force-redirect")).toBe("/auth/post-login");
  });

  it("o HTML do servidor não traz o SignIn, mesmo com o Clerk carregado", () => {
    // Fixa o lado servidor do portão: a saída não depende do estado do Clerk.
    clerkState.loaded = true;
    expect(renderToString(<SignIn />)).toBe("");
  });
});
