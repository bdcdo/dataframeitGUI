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
  it("propaga falha da operação atômica", async () => {
    const { syncAutoRevisaoAssignmentStatus: sync } = await import(
      "@/lib/auto-revisao-sync"
    );
    const client = clientWithResults({
      "rpc:sync_auto_review_assignment_status": {
        error: { message: "sync indisponível" },
      },
    });

    await expect(sync(client as never, "p1", "doc1", "member1")).rejects.toThrow(
      "sync indisponível",
    );
  });

  // O fechamento não pode voltar a ser SELECT→UPDATE por fora da RPC: era essa
  // a corrida que deixava o documento fora da fila com campo pendente vivo.
  it("delega o fechamento à RPC, sem ler ou escrever tabelas direto", async () => {
    const { syncAutoRevisaoAssignmentStatus: sync } = await import(
      "@/lib/auto-revisao-sync"
    );
    const touchedTables: string[] = [];
    const rpcCalls: { name: string; args: unknown }[] = [];
    const client = {
      rpc(name: string, args: unknown) {
        rpcCalls.push({ name, args });
        return Promise.resolve({ data: true, error: null });
      },
      from(table: string) {
        touchedTables.push(table);
        throw new Error(`acesso direto a ${table} fora da RPC`);
      },
    };

    await sync(client as never, "p1", "doc1", "member1");

    expect(touchedTables).toEqual([]);
    expect(rpcCalls).toEqual([
      {
        name: "sync_auto_review_assignment_status",
        args: {
          p_project_id: "p1",
          p_document_id: "doc1",
          p_user_id: "member1",
        },
      },
    ]);
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
