import { describe, it, expect, beforeEach, vi } from "vitest";

// Interlock de escrita da impersonação (issue #428). requireWritableUser declara
// UMA vez a política que resolveEffectiveUserId usa para leitura (`isMaster &&
// impersonating`): só o master, e só quando o caller sinaliza que está em
// "visualizar como", é barrado. Não-master ignora o sinal; sem sessão, falha
// fechado. Espelha viewas-no-write.test.ts, que trava o lado da leitura.

const hoisted = vi.hoisted(() => ({
  isMaster: true,
  hasSession: true,
}));

vi.mock("@clerk/nextjs/server", () => ({
  currentUser: async () =>
    hoisted.hasSession
      ? {
          id: "clerk_user",
          publicMetadata: { supabase_uid: "user_1" },
          emailAddresses: [{ emailAddress: "user@exemplo.com" }],
          firstName: "User",
          lastName: "Test",
        }
      : null,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => {
    throw new Error("não usado");
  },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdmin: () => ({
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "limit"]) builder[m] = () => builder;
      builder.maybeSingle = async () =>
        table === "master_users"
          ? { data: hoisted.isMaster ? { user_id: "user_1" } : null, error: null }
          : { data: null, error: null };
      return builder;
    },
  }),
}));

async function loadRequireWritable() {
  return (await import("@/lib/auth")).requireWritableUser;
}

beforeEach(() => {
  vi.resetModules();
  hoisted.isMaster = true;
  hoisted.hasSession = true;
});

describe("requireWritableUser", () => {
  it("master + impersonating=true → bloqueia (ok:false)", async () => {
    const requireWritableUser = await loadRequireWritable();
    const result = await requireWritableUser({ impersonating: true });
    expect(result).toEqual({
      ok: false,
      error: "Ação indisponível ao visualizar como outro membro.",
    });
  });

  it("master sem sinal de impersonação → grava (ok:true)", async () => {
    const requireWritableUser = await loadRequireWritable();
    const result = await requireWritableUser();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.user.id).toBe("user_1");
  });

  it("não-master ignora impersonating=true → grava (ok:true)", async () => {
    hoisted.isMaster = false;
    const requireWritableUser = await loadRequireWritable();
    const result = await requireWritableUser({ impersonating: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.user.id).toBe("user_1");
  });

  it("sem sessão → falha fechado (ok:false)", async () => {
    hoisted.hasSession = false;
    const requireWritableUser = await loadRequireWritable();
    const result = await requireWritableUser({ impersonating: true });
    expect(result).toEqual({ ok: false, error: "Não autenticado" });
  });
});
