// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderToString } from "react-dom/server";
import { hydrateFromServerHtml } from "@/test-utils/hydration";

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
  clerkState.loaded = false;
  clerkState.lastProps = undefined;
});

// As mesmas props que a página de login passa.
const LOGIN_PROPS = {
  fallbackRedirectUrl: "/auth/post-login",
  forceRedirectUrl: "/auth/post-login",
};

// O HTML do servidor sai com o Clerk descarregado (sempre o caso lá); o
// clerk-js termina de carregar ANTES de a hidratação chegar ao componente — a
// ordem que produz o "Hydration failed" intermitente em /auth/login.
function hydrateAfterClerkLoaded(element: React.ReactElement) {
  return hydrateFromServerHtml(element, {
    beforeHydrate: () => {
      clerkState.loaded = true;
    },
  });
}

describe("clerk-ui SignIn — portão de hidratação", () => {
  it("controle: sem o portão, o Clerk carregado antes da hidratação quebra a hidratação", async () => {
    // Prova de que o mock reproduz o mecanismo. Se este teste deixar de falhar
    // a hidratação, o teste de baixo vira vácuo e precisa ser revisto.
    const { hydrationErrors } = await hydrateAfterClerkLoaded(
      <ClerkSignIn {...LOGIN_PROPS} />,
    );

    expect(hydrationErrors.join("\n")).toMatch(/Hydration failed/);
  });

  it("com o portão, hidrata sem divergência e monta o SignIn logo depois", async () => {
    const { container, hydrationErrors } = await hydrateAfterClerkLoaded(
      <SignIn {...LOGIN_PROPS} />,
    );

    expect(hydrationErrors).toEqual([]);
    const node = container.querySelector('[data-clerk-component="SignIn"]');
    expect(node, "o SignIn não montou depois da hidratação").not.toBeNull();
    // As props chegam ao componente do Clerk sem perda.
    expect(clerkState.lastProps).toEqual(LOGIN_PROPS);
  });

  it("o HTML do servidor não traz o SignIn, mesmo com o Clerk carregado", () => {
    // Fixa o lado servidor do portão: a saída não depende do estado do Clerk.
    clerkState.loaded = true;
    expect(renderToString(<SignIn />)).toBe("");
  });
});
