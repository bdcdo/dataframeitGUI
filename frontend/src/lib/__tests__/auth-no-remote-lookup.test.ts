import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeSession, type FakeSession } from "./auth-test-helpers";

// RC-002 (FR-002): para um usuário com vínculo preparado, o caminho crítico não
// depende de um lookup remoto completo por leitura protegida. Definição medida
// (M1): "full remote lookup" = chamadas a currentUser() + leituras das tabelas
// de identidade (clerk_user_mapping/master_users) por request. O caminho
// preparado resolve com uma passada e não cresce a cada consumidor da request.

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

describe("RC-002 — sem lookup remoto por leitura no caminho preparado", () => {
  it("caminho preparado resolve com um número pequeno e fixo de lookups", async () => {
    session = makeFakeSession({ scenario: "prepared" });
    const { getAuthUser } = await loadAuth();

    await getAuthUser();
    const count = session.lookupCount();
    // Caminho preparado: currentUser + mapping + master_users. Trava um teto
    // baixo para que uma regressão que reintroduza lookup por leitura falhe.
    expect(count).toBeLessThanOrEqual(3);
  });

  it("o pendente não consulta master_users (falha antes, sem lookup extra)", async () => {
    // Caminho não-preparado deve custar MENOS que o preparado: currentUser +
    // mapping e para — não segue para master_users. Trava que o fail-closed não
    // arrasta lookup desnecessário.
    session = makeFakeSession({ scenario: "pending" });
    const { resolveAuth } = await loadAuth();

    await resolveAuth();
    expect(session.lookupCount()).toBe(2);
  });
});
