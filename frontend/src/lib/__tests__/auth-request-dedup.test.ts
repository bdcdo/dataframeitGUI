import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeSession, type FakeSession } from "./auth-test-helpers";

// RC-001 (SC-002): a identidade é resolvida uma vez por request e reutilizada.
// O mecanismo de dedup cross-call é o `cache()` do React, que só memoiza dentro
// de um request scope RSC real — fora dele (unit test) `cache()` chama direto.
// Portanto, o que se testa aqui é a propriedade unit-reproduzível e igualmente
// importante: uma ÚNICA resolução não faz lookup remoto redundante interno
// (sem N+1 dentro de resolveAuth), e getAuthUser é fina camada sobre ela. A
// dedup entre múltiplos consumidores da mesma request é garantia de runtime do
// `cache()`, coberta pela instrumentação de T010 e pelo gate estrutural de
// T028 (layouts não podem chamar currentUser()/auth() por conta própria).

let session: FakeSession;

vi.mock("@clerk/nextjs/server", () => ({
  currentUser: () => session.currentUser(),
  auth: async () => ({ userId: session.clerkUserId }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdmin: () => session.admin(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => {
    throw new Error("não usado");
  },
}));

beforeEach(() => {
  vi.resetModules();
});

async function loadAuth() {
  return await import("@/lib/auth");
}

describe("RC-001 — resolução única sem redundância interna", () => {
  it("uma resolução do caminho preparado faz currentUser + mapping + master uma vez cada", async () => {
    session = makeFakeSession({ scenario: "prepared" });
    const { resolveAuth } = await loadAuth();

    await resolveAuth();
    // currentUser (1) + clerk_user_mapping (1) + master_users (1) = 3.
    // Um lookup a mais denuncia N+1 dentro da resolução.
    expect(session.lookupCount()).toBe(3);
  });

  it("getAuthUser resolve pela mesma passada de resolveAuth (uma resolução)", async () => {
    session = makeFakeSession({ scenario: "prepared" });
    const { getAuthUser } = await loadAuth();

    const user = await getAuthUser();
    expect(user?.id).toBe(session.supabaseUid);
    expect(session.lookupCount()).toBe(3);
  });
});
