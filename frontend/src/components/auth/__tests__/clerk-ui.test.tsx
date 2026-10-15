// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";

// O Clerk é fronteira externa: o mock reproduz só o traço que causa o bug, o
// `clerk.loaded` lido ao vivo no render (no `@clerk/react` real, o getter
// `IsomorphicClerk.loaded`). Carregado, emite o mesmo nó que o `SignIn` real
// emite (`data-clerk-component`); não carregado, nada, como no servidor.
const clerkState = vi.hoisted(() => ({
  loaded: false,
  lastProps: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@clerk/nextjs", () => ({
  SignIn: (props: Record<string, unknown>) => {
    clerkState.lastProps = props;
    return clerkState.loaded ? <div data-clerk-component="SignIn" /> : null;
  },
}));

import { SignIn as ClerkSignIn } from "@clerk/nextjs";
import { SignIn } from "../clerk-ui";

afterEach(() => {
  cleanup();
  clerkState.loaded = false;
  clerkState.lastProps = undefined;
});

// As mesmas props que a página de login passa.
const LOGIN_PROPS = {
  fallbackRedirectUrl: "/auth/post-login",
  forceRedirectUrl: "/auth/post-login",
};

// No servidor o Clerk nunca está carregado, então o HTML desta subárvore é
// vazio — com ou sem o portão. A hidratação parte desse container vazio, depois
// de o clerk-js já ter terminado de carregar: a ordem que produz o "Hydration
// failed" intermitente em /auth/login.
function hydrateAfterClerkLoaded(ui: React.ReactElement): {
  container: HTMLElement;
  recoverable: unknown[];
} {
  const container = document.body.appendChild(document.createElement("div"));
  clerkState.loaded = true;
  const recoverable: unknown[] = [];
  render(ui, {
    container,
    hydrate: true,
    onRecoverableError: (error) => recoverable.push(error),
  });
  return { container, recoverable };
}

describe("clerk-ui SignIn — portão de hidratação", () => {
  it("controle: sem o portão, o Clerk carregado antes da hidratação quebra a hidratação", () => {
    // Prova de que o mock reproduz o mecanismo. Se este teste deixar de falhar
    // a hidratação, o teste de baixo vira vácuo e precisa ser revisto.
    const silence = vi.spyOn(console, "error").mockImplementation(() => {});
    const { recoverable } = hydrateAfterClerkLoaded(
      <ClerkSignIn {...LOGIN_PROPS} />,
    );
    silence.mockRestore();

    expect(recoverable.map(String).join("\n")).toMatch(/Hydration failed/);
  });

  it("com o portão, hidrata sem divergência e monta o SignIn logo depois", () => {
    const { container, recoverable } = hydrateAfterClerkLoaded(
      <SignIn {...LOGIN_PROPS} />,
    );

    expect(recoverable).toEqual([]);
    const node = container.querySelector('[data-clerk-component="SignIn"]');
    expect(node, "o SignIn não montou depois da hidratação").not.toBeNull();
    // As props chegam ao componente do Clerk sem perda.
    expect(clerkState.lastProps).toEqual(LOGIN_PROPS);
  });
});
