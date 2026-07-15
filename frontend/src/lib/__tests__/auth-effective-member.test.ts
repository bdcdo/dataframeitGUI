import { describe, it, expect, beforeEach, vi } from "vitest";

// getEffectiveMemberId (spec 002): resolve o membro canônico quando a conta
// atual é alias (member_email_links.linked_user_id) no projeto; senão, a
// própria conta. getAuthUser/getEffectiveMemberId usam React cache() — cada
// teste usa um projectId distinto para não colidir com memoização.
let aliasesByProject: Record<string, { member_user_id: string }[]>;
let aliasErrorByProject: Record<string, { message: string } | null>;
let aliasQueryCalls: Array<{
  projectId: string | null;
  linkedUserId: string | null;
  limit: number | null;
}>;

vi.mock("@clerk/nextjs/server", () => ({
  currentUser: async () => ({
    id: "clerk_acc1",
    publicMetadata: { supabase_uid: "acc1" },
    emailAddresses: [{ emailAddress: "acc1@exemplo.com" }],
    firstName: "Conta",
    lastName: "Vinculada",
  }),
}));

vi.mock("@/lib/clerk-sync", () => ({
  syncClerkUserToSupabase: async () => "acc1",
}));

function makeAliasClient() {
  return {
    from: (table: string) => {
      let projectId: string | null = null;
      let linkedUserId: string | null = null;
      let rowLimit: number | null = null;
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "is", "in", "order", "maybeSingle", "single", "update"]) {
        builder[m] = () => builder;
      }
      builder.eq = (col: string, value: string) => {
        if (col === "project_id") projectId = value;
        if (col === "linked_user_id") linkedUserId = value;
        return builder;
      };
      builder.limit = (value: number) => {
        rowLimit = value;
        return builder;
      };
      builder.then = (resolve: (v: unknown) => unknown) => {
        if (table === "member_email_links") {
          aliasQueryCalls.push({ projectId, linkedUserId, limit: rowLimit });
          const matchingAliases =
            projectId && linkedUserId === "acc1"
              ? (aliasesByProject[projectId] ?? [])
              : [];
          return resolve({
            data:
              rowLimit === null
                ? matchingAliases
                : matchingAliases.slice(0, rowLimit),
            error: projectId ? (aliasErrorByProject[projectId] ?? null) : null,
          });
        }
        if (table === "profiles") {
          return resolve({ data: { activated_at: "2026-01-01" }, error: null });
        }
        return resolve({ data: null, error: null });
      };
      return builder;
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => makeAliasClient(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdmin: () => makeAliasClient(),
}));

beforeEach(() => {
  aliasesByProject = {};
  aliasErrorByProject = {};
  aliasQueryCalls = [];
});

async function loadGetEffective() {
  return (await import("@/lib/auth")).getEffectiveMemberId;
}

async function loadResolveEffective() {
  return (await import("@/lib/auth")).resolveEffectiveUserId;
}

describe("getEffectiveMemberId", () => {
  it("com alias no projeto → retorna o member_user_id canônico", async () => {
    aliasesByProject = { pA: [{ member_user_id: "canonico1" }] };
    const getEffectiveMemberId = await loadGetEffective();
    await expect(getEffectiveMemberId("pA")).resolves.toBe("canonico1");
    expect(aliasQueryCalls).toEqual([
      { projectId: "pA", linkedUserId: "acc1", limit: 100 },
    ]);
  });

  it("sem alias no projeto → retorna o próprio user.id", async () => {
    aliasesByProject = { pB: [] };
    const getEffectiveMemberId = await loadGetEffective();
    await expect(getEffectiveMemberId("pB")).resolves.toBe("acc1");
  });

  it("alias em outro projeto não vaza (efeito restrito ao projeto, FR-013)", async () => {
    aliasesByProject = {
      pC: [{ member_user_id: "canonico1" }],
      pD: [],
    };
    const getEffectiveMemberId = await loadGetEffective();
    await expect(getEffectiveMemberId("pD")).resolves.toBe("acc1");
  });

  it("falha da consulta de alias não degrada para user.id", async () => {
    aliasErrorByProject = { pError: { message: "RLS indisponível" } };
    const getEffectiveMemberId = await loadGetEffective();
    await expect(getEffectiveMemberId("pError")).rejects.toThrow(
      "Não foi possível resolver a identidade no projeto.",
    );
  });

  it("vários vínculos para o mesmo membro canônico preservam a identidade", async () => {
    aliasesByProject = {
      pRepeated: [
        { member_user_id: "canonico1" },
        { member_user_id: "canonico1" },
      ],
    };
    const getEffectiveMemberId = await loadGetEffective();
    await expect(getEffectiveMemberId("pRepeated")).resolves.toBe("canonico1");
  });

  it("vínculos para membros canônicos distintos falham fechado", async () => {
    aliasesByProject = {
      pAmbiguous: [
        { member_user_id: "canonico1" },
        { member_user_id: "canonico2" },
      ],
    };
    const getEffectiveMemberId = await loadGetEffective();
    await expect(getEffectiveMemberId("pAmbiguous")).rejects.toThrow(
      "Não foi possível resolver a identidade no projeto.",
    );
  });

  it("atingir o limite de vínculos falha fechado mesmo com destino único", async () => {
    aliasesByProject = {
      pTruncated: Array.from({ length: 100 }, () => ({
        member_user_id: "canonico1",
      })),
    };
    const getEffectiveMemberId = await loadGetEffective();
    await expect(getEffectiveMemberId("pTruncated")).rejects.toThrow(
      "Não foi possível resolver a identidade no projeto.",
    );
    expect(aliasQueryCalls).toEqual([
      { projectId: "pTruncated", linkedUserId: "acc1", limit: 100 },
    ]);
  });
});

// resolveEffectiveUserId: fonte única da precedência entre impersonação
// master (?viewAsUser=) e conta-alias, compartilhada por Codificar,
// Comparação e Arbitragem. Sem ela, Comparação/Arbitragem filtravam a fila
// pessoal pelo id do master logado e mostravam fila vazia na impersonação.
describe("resolveEffectiveUserId", () => {
  it("master + viewAsUser → impersona (precedência sobre alias)", async () => {
    aliasesByProject = { pE: [{ member_user_id: "canonico1" }] };
    const resolveEffectiveUserId = await loadResolveEffective();
    await expect(
      resolveEffectiveUserId("pE", { id: "acc1", isMaster: true }, "membro9"),
    ).resolves.toEqual({ effectiveUserId: "membro9", isImpersonating: true });
  });

  it("não-master ignora viewAsUser e resolve alias", async () => {
    aliasesByProject = { pF: [{ member_user_id: "canonico1" }] };
    const resolveEffectiveUserId = await loadResolveEffective();
    await expect(
      resolveEffectiveUserId("pF", { id: "acc1", isMaster: false }, "membro9"),
    ).resolves.toEqual({ effectiveUserId: "canonico1", isImpersonating: false });
  });

  it("master sem viewAsUser cai na resolução de alias/si próprio", async () => {
    aliasesByProject = { pG: [] };
    const resolveEffectiveUserId = await loadResolveEffective();
    await expect(
      resolveEffectiveUserId("pG", { id: "acc1", isMaster: true }, undefined),
    ).resolves.toEqual({ effectiveUserId: "acc1", isImpersonating: false });
  });
});
