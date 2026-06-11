import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { updateOrThrow, deleteOrThrow, ZeroRowsError } from "../supabase/rls-guard";

// Client mínimo: registra a cadeia chamada e resolve com o resultado fixado.
function makeClient(result: { data: unknown; error: { message: string } | null }) {
  const calls: Record<string, unknown[]> = {};
  const builder = {
    update(payload: unknown) {
      calls.update = [payload];
      return builder;
    },
    delete() {
      calls.delete = [];
      return builder;
    },
    match(m: unknown) {
      calls.match = [m];
      return builder;
    },
    select(col: string) {
      calls.select = [col];
      return Promise.resolve(result);
    },
  };
  const client = { from: (table: string) => ((calls.from = [table]), builder) };
  return { client: client as unknown as SupabaseClient, calls };
}

describe("updateOrThrow", () => {
  it("retorna as linhas afetadas no caminho feliz", async () => {
    const { client, calls } = makeClient({ data: [{ id: "p1" }], error: null });
    const rows = await updateOrThrow(client, "projects", { name: "X" }, { id: "p1" });
    expect(rows).toEqual([{ id: "p1" }]);
    expect(calls.from).toEqual(["projects"]);
    expect(calls.match).toEqual([{ id: "p1" }]);
    expect(calls.select).toEqual(["id"]);
  });

  it("lança Error com a mensagem do PostgREST em erro real", async () => {
    const { client } = makeClient({ data: null, error: { message: "boom" } });
    await expect(
      updateOrThrow(client, "projects", { name: "X" }, { id: "p1" }),
    ).rejects.toThrow("boom");
  });

  it("lança ZeroRowsError em 0 linhas (RLS filtrou ou registro inexistente)", async () => {
    const { client } = makeClient({ data: [], error: null });
    const promise = updateOrThrow(client, "projects", { name: "X" }, { id: "p1" });
    await expect(promise).rejects.toBeInstanceOf(ZeroRowsError);
    await expect(promise).rejects.toThrow(/sem permissão/i);
  });

  it("usa a copy custom de opts.message", async () => {
    const { client } = makeClient({ data: [], error: null });
    await expect(
      updateOrThrow(client, "projects", { name: "X" }, { id: "p1" }, {
        message: "Sem permissão para alterar este projeto.",
      }),
    ).rejects.toThrow("Sem permissão para alterar este projeto.");
  });

  it("respeita selectColumn custom para tabelas sem coluna id", async () => {
    const { client, calls } = makeClient({ data: [{ review_id: "r1" }], error: null });
    await updateOrThrow(client, "verdict_acknowledgments", { resolved_at: null }, { review_id: "r1" }, {
      selectColumn: "review_id",
    });
    expect(calls.select).toEqual(["review_id"]);
  });
});

describe("deleteOrThrow", () => {
  it("retorna as linhas removidas no caminho feliz", async () => {
    const { client, calls } = makeClient({ data: [{ id: "r1" }], error: null });
    const rows = await deleteOrThrow(client, "rounds", { id: "r1" });
    expect(rows).toEqual([{ id: "r1" }]);
    expect(calls.delete).toEqual([]);
  });

  it("lança ZeroRowsError em 0 linhas", async () => {
    const { client } = makeClient({ data: [], error: null });
    await expect(deleteOrThrow(client, "rounds", { id: "r1" })).rejects.toBeInstanceOf(
      ZeroRowsError,
    );
  });
});
