import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  makeSupabaseAdminModuleMock,
  makeSupabaseServerModuleMock,
} from "@/test-utils/supabase-mock";

// T024 (FR-006): viewAs/impersonação é escopo de LEITURA. resolveEffectiveUserId
// devolve o par (effectiveUserId, isImpersonating): master + viewAsUser resolve
// para a identidade visualizada com isImpersonating=true, e o efeito é restrito
// a leitura/navegação/fila. O invariante de escrita é que as write surfaces
// gravam como a identidade canônica da conta autenticada, nunca como o
// effectiveUserId visualizado quando isImpersonating — este teste trava a
// distinção necessária para não escrever em nome do usuário visualizado.

let aliasByProject: Record<string, { member_user_id: string } | null>;

function makeClient() {
  return {
    from: (table: string) => {
      let projectId: string | null = null;
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "order", "limit"]) builder[m] = () => builder;
      builder.eq = (col: string, value: string) => {
        if (col === "project_id") projectId = value;
        return builder;
      };
      builder.maybeSingle = async () =>
        table === "member_email_links"
          ? { data: projectId ? aliasByProject[projectId] ?? null : null, error: null }
          : { data: null, error: null };
      return builder;
    },
  };
}

vi.mock("@clerk/nextjs/server", () => ({
  currentUser: async () => ({
    id: "clerk_master",
    publicMetadata: { supabase_uid: "master_1" },
    emailAddresses: [{ emailAddress: "master@exemplo.com" }],
    firstName: "Master",
    lastName: "User",
  }),
}));

vi.mock("@/lib/supabase/server", () => makeSupabaseServerModuleMock(makeClient));
vi.mock("@/lib/supabase/admin", () => makeSupabaseAdminModuleMock(makeClient));

async function loadResolveEffective() {
  return (await import("@/lib/auth")).resolveEffectiveUserId;
}

beforeEach(() => {
  vi.resetModules();
  aliasByProject = {};
});

describe("resolveEffectiveUserId — viewAs é leitura, não escrita", () => {
  it("master + viewAsUser → effectiveUserId visualizado e isImpersonating=true", async () => {
    aliasByProject = { pX: null };
    const resolve = await loadResolveEffective();
    const r = await resolve("pX", { id: "master_1", isMaster: true }, "membro_visto");
    expect(r).toEqual({
      effectiveUserId: "membro_visto",
      isImpersonating: true,
    });
    // A conta autenticada (master_1) permanece distinta do effectiveUserId —
    // as write surfaces nunca gravam como membro_visto.
    expect(r.effectiveUserId).not.toBe("master_1");
  });

  it("não-master ignora viewAsUser (não pode se passar por outro)", async () => {
    // Sem alias, a identidade efetiva resolve para o próprio ator autenticado
    // (getEffectiveMemberId → getAuthUser = master_1 no mock); viewAsUser é
    // ignorado porque isMaster=false, então não há impersonação.
    aliasByProject = { pY: null };
    const resolve = await loadResolveEffective();
    const r = await resolve("pY", { id: "master_1", isMaster: false }, "membro_visto");
    expect(r.isImpersonating).toBe(false);
    expect(r.effectiveUserId).toBe("master_1");
  });
});
