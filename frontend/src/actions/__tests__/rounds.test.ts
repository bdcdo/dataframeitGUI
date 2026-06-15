import { describe, it, expect, beforeEach, vi } from "vitest";

// Testes da detecção de 0-rows nos UPDATEs de rounds/projects (#178): o
// PostgREST devolve sucesso com 0 linhas quando a RLS filtra — as actions
// devem devolver { error } em vez de sucesso falso. Mock compartilhado
// (supabase-mock.ts), fila de resultados por tabela.
import {
  makeSupabaseMock,
  type TableResult,
  type TableResults,
  type WriteCall,
} from "./supabase-mock";

let writeCalls: WriteCall[];
let serverTableResults: TableResults | undefined;

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
}));
vi.mock("@/lib/auth", () => ({
  // Criador do projeto: assertCoordinator dá short-circuit na 1ª query de
  // projects (created_by === user.id).
  getAuthUser: async () => ({ id: "userCoord", isMaster: false }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () =>
    makeSupabaseMock({ tableResults: serverTableResults, writeCalls }),
}));

import {
  createRound,
  renameRound,
  setCurrentRound,
  setRoundStrategy,
} from "../rounds";

// 1ª query de projects em toda action: o select de created_by do assertCoordinator.
const ASSERT_COORD: TableResult = { data: { created_by: "userCoord" } };

beforeEach(() => {
  writeCalls = [];
  serverTableResults = undefined;
});

describe("setCurrentRound", () => {
  it("retorna erro quando o UPDATE de projects é filtrado (0 linhas)", async () => {
    serverTableResults = { projects: [ASSERT_COORD, { data: [] }] };
    const r = await setCurrentRound("p1", null);
    expect(r.error).toMatch(/Sem permissão/);
  });

  it("caminho feliz: sem erro quando o UPDATE afeta 1 linha", async () => {
    serverTableResults = { projects: [ASSERT_COORD, { data: [{ id: "p1" }] }] };
    const r = await setCurrentRound("p1", null);
    expect(r.error).toBeUndefined();
  });
});

describe("setRoundStrategy", () => {
  it("retorna erro em 0 linhas", async () => {
    serverTableResults = { projects: [ASSERT_COORD, { data: [] }] };
    const r = await setRoundStrategy("p1", "manual");
    expect(r.error).toMatch(/Sem permissão/);
  });
});

describe("renameRound", () => {
  it("retorna erro quando o UPDATE de rounds não casa nenhuma linha", async () => {
    serverTableResults = {
      projects: [ASSERT_COORD],
      rounds: { data: [] },
    };
    const r = await renameRound("p1", "r1", "Rodada 2");
    expect(r.error).toMatch(/Sem permissão/);
  });
});

describe("createRound(setAsCurrent=true)", () => {
  it("estado parcial: rodada criada mas current_round_id não setado → devolve id E erro", async () => {
    serverTableResults = {
      projects: [ASSERT_COORD, { data: [] }],
      rounds: { data: { id: "r1" } },
    };
    const r = await createRound("p1", "Rodada 1", true);
    expect(r.id).toBe("r1");
    expect(r.error).toMatch(/não foi possível defini-la como atual/);
  });

  it("caminho feliz: devolve id sem erro", async () => {
    serverTableResults = {
      projects: [ASSERT_COORD, { data: [{ id: "p1" }] }],
      rounds: { data: { id: "r1" } },
    };
    const r = await createRound("p1", "Rodada 1", true);
    expect(r.id).toBe("r1");
    expect(r.error).toBeUndefined();
  });
});
