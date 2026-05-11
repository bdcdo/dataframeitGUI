import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks precisam ser declarados antes do import dinamico do modulo sob teste.
// unstable_cache: aplica a fn imediatamente, sem cache, para o teste rodar offline.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
}));

type Assignment = {
  id: string;
  status: string;
  deadline: string | null;
  completed_at: string | null;
  // Quando INNER JOIN com documents resolve, o Supabase devolve a relacao
  // como objeto/array. Aqui simulamos a presenca (apos o filtro is(null)).
  documents: { id: string };
};

let lastSelect = "";
let isCalls: { col: string; val: unknown }[] = [];
let resolvedAssignments: Assignment[] = [];

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdmin: () => ({
    from: (_table: string) => {
      const builder = {
        select: (cols: string) => {
          lastSelect = cols;
          return builder;
        },
        eq: () => builder,
        is: (col: string, val: unknown) => {
          isCalls.push({ col, val });
          return builder;
        },
        // Chainable thenable: await builder retorna { data, error }.
        then: (
          resolve: (v: { data: Assignment[]; error: null }) => unknown,
        ) => resolve({ data: resolvedAssignments, error: null }),
      };
      return builder;
    },
  }),
}));

beforeEach(() => {
  lastSelect = "";
  isCalls = [];
  resolvedAssignments = [];
});

async function loadProgress() {
  return (await import("@/actions/progress")).getResearcherProgress;
}

describe("getResearcherProgress — filtro de documentos soft-deletados", () => {
  it("monta query com INNER JOIN documents + excluded_at IS NULL", async () => {
    resolvedAssignments = [];
    const getResearcherProgress = await loadProgress();
    await getResearcherProgress("proj-1", "user-1");

    // Regression guard: sem esses dois, contagem incluiria assignments
    // orfaos cujo documento foi soft-deletado (PR #100).
    expect(lastSelect).toContain("documents!inner(id)");
    expect(isCalls).toContainEqual({ col: "documents.excluded_at", val: null });
  });

  it("total e completed refletem somente assignments retornados pela query (docs ativos)", async () => {
    // Simula o estado pos-filtro: docs soft-deletados ja foram descartados
    // pelo INNER JOIN, entao a query devolve apenas os 3 ativos.
    resolvedAssignments = [
      {
        id: "a1",
        status: "concluido",
        deadline: null,
        completed_at: "2026-05-10T12:00:00Z",
        documents: { id: "d1" },
      },
      {
        id: "a2",
        status: "pendente",
        deadline: null,
        completed_at: null,
        documents: { id: "d2" },
      },
      {
        id: "a3",
        status: "pendente",
        deadline: null,
        completed_at: null,
        documents: { id: "d3" },
      },
    ];

    const getResearcherProgress = await loadProgress();
    const progress = await getResearcherProgress("proj-1", "user-1");

    expect(progress.total).toBe(3);
    expect(progress.completed).toBe(1);
  });
});
