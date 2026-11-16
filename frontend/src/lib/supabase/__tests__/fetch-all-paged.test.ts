import { describe, it, expect } from "vitest";
import { fetchAllPaged, fetchAllAfterId, fetchAllAfterDocumentField, fetchByDocumentChunks, rowsOrThrow } from "@/lib/supabase/fetch-all-paged";
import { makeFilterAwareSupabaseMock } from "@/test-utils/supabase-mock";

const PAGE_SIZE = 1000;

interface Row {
  id: number;
}

// Builder falso no formato mínimo que `fetchAllPaged` consome. Registra as
// colunas de ordenação e as faixas pedidas para que o teste possa afirmar sobre
// a query montada, e não só sobre o resultado.
function fakeSource(
  pages: Array<{ data: Row[] | null; error: { message: string } | null }>,
) {
  const orders: string[][] = [];
  const ranges: Array<[number, number]> = [];
  let page = 0;

  const build = () => {
    const applied: string[] = [];
    const builder = {
      order(column: string) {
        applied.push(column);
        return builder;
      },
      range(from: number, to: number) {
        orders.push(applied);
        ranges.push([from, to]);
        return Promise.resolve(pages[page++] ?? { data: [], error: null });
      },
    };
    return builder;
  };

  return { build, orders, ranges };
}

function rows(count: number, offset = 0): Row[] {
  return Array.from({ length: count }, (_, i) => ({ id: offset + i }));
}

function selectMock(mock: ReturnType<typeof makeFilterAwareSupabaseMock>, table: string, columns: string): never {
  const builder = mock.from(table);
  return (builder.select as (columns: string) => unknown)(columns) as never;
}

describe("fetchAllPaged", () => {
  it("aplica a ordem pedida em TODA página, não só na primeira", () => {
    const src = fakeSource([
      { data: rows(PAGE_SIZE), error: null },
      { data: rows(3, PAGE_SIZE), error: null },
    ]);

    return fetchAllPaged<Row>(src.build, ["document_id", "field_name"]).then(
      ({ data }) => {
        expect(data).toHaveLength(PAGE_SIZE + 3);
        expect(src.ranges).toEqual([
          [0, PAGE_SIZE - 1],
          [PAGE_SIZE, 2 * PAGE_SIZE - 1],
        ]);
        // A segunda página é uma query NOVA (o builder do PostgREST é de uso
        // único): sem reaplicar a ordem, o OFFSET dela cairia sobre uma
        // ordenação arbitrária e poderia repetir ou pular linhas da primeira.
        expect(src.orders).toEqual([
          ["document_id", "field_name"],
          ["document_id", "field_name"],
        ]);
      },
    );
  });

  it("para na primeira página incompleta", async () => {
    const src = fakeSource([{ data: rows(10), error: null }]);

    const { data, error } = await fetchAllPaged<Row>(src.build, ["id"]);

    expect(error).toBeNull();
    expect(data).toHaveLength(10);
    expect(src.ranges).toHaveLength(1);
  });

  it("devolve o erro junto do que já acumulou — o caller decide", async () => {
    const src = fakeSource([
      { data: rows(PAGE_SIZE), error: null },
      { data: null, error: { message: "conexão perdida" } },
    ]);

    const { data, error } = await fetchAllPaged<Row>(src.build, ["id"]);

    // O array vem TRUNCADO. É por isso que ignorar o `error` numa fonte
    // estrutural não devolve "menos dados", devolve número errado.
    expect(data).toHaveLength(PAGE_SIZE);
    expect(error).toEqual({ message: "conexão perdida" });
  });
});

describe("cursor nos contratos id e (document_id, field_name)", () => {
  it.each(["remove", "insere"] as const)("id não repete nem pula ao %s antes da segunda página", async (change) => {
    const data = Array.from({ length: 1001 }, (_, i) => ({ id: `r${String(i).padStart(4, "0")}` }));
    let reads = 0;
    const mock = makeFilterAwareSupabaseMock({
      tableData: { rows: data }, writeCalls: [],
      afterRead: (table) => {
        if (table !== "rows" || ++reads !== 1) return;
        if (change === "remove") data.shift();
        else data.unshift({ id: "r0000a" });
      },
    });
    const result = await fetchAllAfterId<{ id: string }>(() => selectMock(mock, "rows", "id"));
    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(1001);
    expect(result.data.at(-1)?.id).toBe("r1000");
    expect(new Set(result.data.map((row) => row.id)).size).toBe(1001);
    expect(result.data.some((row) => row.id === "r0000a")).toBe(false);
    expect(reads).toBe(2);
  });

  it("a chave composta avança no mesmo documento e no seguinte após remoção", async () => {
    const data = [
      ...Array.from({ length: 1001 }, (_, i) => ({
        document_id: "d1", field_name: `f${String(i).padStart(4, "0")}`,
      })),
      { document_id: "d2", field_name: "f0000" },
    ];
    let reads = 0;
    const mock = makeFilterAwareSupabaseMock({
      tableData: { final_answers: data }, writeCalls: [],
      afterRead: (table) => {
        if (table === "final_answers" && ++reads === 1) data.shift();
      },
    });
    const result = await fetchAllAfterDocumentField<{ document_id: string; field_name: string }>(() => selectMock(mock, "final_answers", "document_id, field_name"));
    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(1002);
    expect(result.data.at(-2)).toEqual({ document_id: "d1", field_name: "f1000" });
    expect(result.data.at(-1)).toEqual({ document_id: "d2", field_name: "f0000" });
    expect(new Set(result.data.map((row) => `${row.document_id}:${row.field_name}`)).size).toBe(1002);
    expect(reads).toBe(2);
  });

  it("vazio e erro intermediário mantêm o contrato de erro explícito", async () => {
    const empty = makeFilterAwareSupabaseMock({ tableData: { rows: [] }, writeCalls: [] });
    expect(await fetchAllAfterId<{ id: string }>(() => selectMock(empty, "rows", "id"))).toEqual({ data: [], error: null });

    let reads = 0;
    const data = Array.from({ length: 1001 }, (_, i) => ({ id: `r${String(i).padStart(4, "0")}` }));
    const failing = makeFilterAwareSupabaseMock({
      tableData: { rows: data }, writeCalls: [],
      queryErrorForCall: ({ table }) => table === "rows" && ++reads === 2 ? { message: "segunda página" } : undefined,
    });
    const result = await fetchAllAfterId<{ id: string }>(() => selectMock(failing, "rows", "id"));
    expect(result.data).toHaveLength(1000);
    expect(result.error).toEqual({ message: "segunda página" });
  });
});

describe("rowsOrThrow", () => {
  it("devolve as linhas, e lista vazia quando a leitura não trouxe nenhuma", () => {
    expect(rowsOrThrow("documents", { data: [{ id: "d1" }], error: null })).toEqual([{ id: "d1" }]);
    expect(rowsOrThrow("documents", { data: null, error: null })).toEqual([]);
  });

  it("lança com o rótulo e guarda o erro original, mesmo com linhas parciais", () => {
    const error = { message: "gateway fora" };
    const thrown = (() => {
      try { rowsOrThrow("responses", { data: [{ id: "r1" }], error }); } catch (e) { return e as Error; }
    })();
    expect(thrown?.message).toBe("responses: gateway fora");
    expect(thrown?.cause).toBe(error);
  });
});

describe("fetchByDocumentChunks", () => {
  // Fora do modo de auto-revisão, num round reiniciado, os candidatos da
  // contagem sem LLM são todos os documentos codificados: sem teto, 5000
  // documentos viravam 50 requisições simultâneas por tabela.
  it("limita os lotes em voo e devolve as linhas na ordem dos lotes", async () => {
    const ids = Array.from({ length: 1_000 }, (_, i) => `d${i}`);
    let inFlight = 0;
    let maxInFlight = 0;
    const { data, error } = await fetchByDocumentChunks(ids, async (chunk) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return { data: chunk, error: null };
    });
    expect(error).toBeNull();
    expect(data).toEqual(ids);
    expect(maxInFlight).toBeLessThanOrEqual(4);
  });

  it("a primeira falha vence e para de abrir lotes novos", async () => {
    const ids = Array.from({ length: 1_000 }, (_, i) => `d${i}`);
    let calls = 0;
    const result = await fetchByDocumentChunks(ids, async (chunk) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 1));
      return chunk[0] === "d0"
        ? { data: [], error: { message: "conexão perdida" } }
        : { data: chunk, error: null };
    });
    expect(result.error).toEqual({ message: "conexão perdida" });
    expect(calls).toBeLessThan(10);
  });
});
