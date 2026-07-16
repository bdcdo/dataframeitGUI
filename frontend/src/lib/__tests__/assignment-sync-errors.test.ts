import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type QueryResult = {
  data?: unknown[] | null;
  error?: { message: string } | null;
};

function clientWithResults(results: Record<string, QueryResult>) {
  return {
    rpc(name: string) {
      return Promise.resolve(results[`rpc:${name}`] ?? { data: null, error: null });
    },
    from(table: string) {
      let operation = "select";
      const builder: Record<string, unknown> = {};
      builder.select = () => {
        operation = "select";
        return builder;
      };
      builder.update = () => {
        operation = "update";
        return builder;
      };
      for (const method of ["eq", "is", "limit"]) {
        builder[method] = () => builder;
      }
      builder.then = (resolve: (result: QueryResult) => unknown) =>
        resolve(results[`${table}:${operation}`] ?? { data: [], error: null });
      return builder;
    },
  };
}

describe("sync de assignment de auto-revisão", () => {
  it("propaga falha da leitura de pendências", async () => {
    const { syncAutoRevisaoAssignmentStatus: sync } = await import(
      "@/lib/auto-revisao-sync"
    );
    const client = clientWithResults({
      "field_reviews:select": { error: { message: "leitura indisponível" } },
    });

    await expect(
      sync(client as never, "p1", "doc1", "member1", "2026-07-15T00:00:00Z"),
    ).rejects.toThrow("leitura indisponível");
  });

  it("propaga falha ao concluir o assignment", async () => {
    const { syncAutoRevisaoAssignmentStatus: sync } = await import(
      "@/lib/auto-revisao-sync"
    );
    const client = clientWithResults({
      "field_reviews:select": { data: [], error: null },
      "assignments:update": { error: { message: "update indisponível" } },
    });

    await expect(
      sync(client as never, "p1", "doc1", "member1", "2026-07-15T00:00:00Z"),
    ).rejects.toThrow("update indisponível");
  });
});

describe("sync de assignment de arbitragem", () => {
  it("propaga falha da operação atômica", async () => {
    const { syncArbitragemAssignmentStatus: sync } = await import(
      "@/lib/arbitragem-sync"
    );
    const client = clientWithResults({
      "rpc:sync_arbitration_assignment_status": {
        error: { message: "sync indisponível" },
      },
    });

    await expect(
      sync(client as never, "p1", "doc1", "member1"),
    ).rejects.toThrow("sync indisponível");
  });
});
