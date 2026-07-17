import { describe, it, expect, beforeEach, vi } from "vitest";

// Testes da detecção de 0-rows nos UPDATEs de rounds/projects (#178): o
// PostgREST devolve sucesso com 0 linhas quando a RLS filtra — as actions
// devem devolver { error } em vez de sucesso falso. Mock compartilhado
// (supabase-mock.ts), fila de resultados por tabela.
import { createSupabaseMockState } from "./supabase-mock";

const supabaseState = createSupabaseMockState();

const requireCoordinator = vi.hoisted(() =>
  vi.fn<
    (
      projectId: string,
      deniedMessage: string,
    ) => Promise<
      | { ok: true; user: { id: string } }
      | {
          ok: false;
          code: "authorization_unavailable";
          error: string;
        }
    >
  >(async () => ({ ok: true, user: { id: "linked-account" } })),
);

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
}));
vi.mock("@/lib/auth", () => ({
  requireCoordinator,
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => supabaseState.createClient(),
}));

import {
  createRound,
  renameRound,
  setCurrentRound,
  setRoundStrategy,
} from "../rounds";

beforeEach(() => {
  supabaseState.reset();
  requireCoordinator.mockReset();
  requireCoordinator.mockResolvedValue({
    ok: true,
    user: { id: "linked-account" },
  });
});

describe("autorização canônica de rodadas", () => {
  it("aceita conta-alias autorizada pelo gate canônico", async () => {
    supabaseState.tableResults = { rounds: { data: { id: "r1" } } };

    const r = await createRound("p1", "Rodada 1");

    expect(r).toEqual({ id: "r1" });
    expect(requireCoordinator).toHaveBeenCalledWith(
      "p1",
      "Apenas coordenadores podem alterar rodadas.",
    );
  });

  it("não escreve quando a autorização está indisponível", async () => {
    requireCoordinator.mockResolvedValueOnce({
      ok: false,
      code: "authorization_unavailable",
      error: "Não foi possível verificar sua permissão. Tente novamente.",
    });

    const r = await setCurrentRound("p1", null);

    expect(r.error).toBe(
      "Não foi possível verificar sua permissão. Tente novamente.",
    );
    expect(supabaseState.writeCalls).toEqual([]);
  });
});

describe("setCurrentRound", () => {
  it("retorna erro quando o UPDATE de projects é filtrado (0 linhas)", async () => {
    supabaseState.tableResults = { projects: { data: [] } };
    const r = await setCurrentRound("p1", null);
    expect(r.error).toMatch(/Sem permissão/);
  });

  it("caminho feliz: sem erro quando o UPDATE afeta 1 linha", async () => {
    supabaseState.tableResults = { projects: { data: [{ id: "p1" }] } };
    const r = await setCurrentRound("p1", null);
    expect(r.error).toBeUndefined();
  });
});

describe("setRoundStrategy", () => {
  it("retorna erro em 0 linhas", async () => {
    supabaseState.tableResults = { projects: { data: [] } };
    const r = await setRoundStrategy("p1", "manual");
    expect(r.error).toMatch(/Sem permissão/);
  });
});

describe("renameRound", () => {
  it("retorna erro quando o UPDATE de rounds não casa nenhuma linha", async () => {
    supabaseState.tableResults = {
      rounds: { data: [] },
    };
    const r = await renameRound("p1", "r1", "Rodada 2");
    expect(r.error).toMatch(/Sem permissão/);
  });
});

describe("createRound(setAsCurrent=true)", () => {
  it("estado parcial: rodada criada mas current_round_id não setado → devolve id E erro", async () => {
    supabaseState.tableResults = {
      projects: { data: [] },
      rounds: { data: { id: "r1" } },
    };
    const r = await createRound("p1", "Rodada 1", true);
    expect(r.id).toBe("r1");
    expect(r.error).toMatch(/não foi possível defini-la como atual/);
  });

  it("caminho feliz: devolve id sem erro", async () => {
    supabaseState.tableResults = {
      projects: { data: [{ id: "p1" }] },
      rounds: { data: { id: "r1" } },
    };
    const r = await createRound("p1", "Rodada 1", true);
    expect(r.id).toBe("r1");
    expect(r.error).toBeUndefined();
  });
});
