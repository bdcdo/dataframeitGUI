import { describe, expect, it } from "vitest";
import { makeFilterAwareSupabaseMock, type WriteCall } from "../supabase-mock";

// O mock filter-aware só serve de prova se não deixar passar linha que o
// Postgres descarta. Com NULL, a lógica do SQL é de três valores: `col <> x`
// é NULL (e não true) quando `col` é NULL, e a linha sai do resultado. Coluna
// ausente no fixture também não passa em nenhum filtro, por convenção do mock
// (o teste declara as colunas que a query filtra; ver supabase-mock.ts).
type Rows = PromiseLike<{ data: Array<{ id: string }> }>;
type Query = Rows & {
  eq(c: string, v: unknown): Query;
  neq(c: string, v: unknown): Query;
  is(c: string, v: unknown): Query;
  in(c: string, v: unknown[]): Query;
};

async function ids(rows: unknown[], build: (q: Query) => Query) {
  const writeCalls: WriteCall[] = [];
  const client = makeFilterAwareSupabaseMock({
    tableData: { t: rows },
    writeCalls,
  });
  const table = client.from("t") as unknown as { select(c: string): Query };
  const { data } = await build(table.select("id"));
  return data.map((r) => r.id);
}

describe("makeFilterAwareSupabaseMock: NULL como no Postgres", () => {
  const rows = [
    { id: "valor-igual", status: "a" },
    { id: "valor-diferente", status: "b" },
    { id: "nulo", status: null },
    { id: "coluna-ausente" },
  ];

  it(".neq descarta NULL e coluna ausente (col <> x é NULL)", async () => {
    expect(await ids(rows, (q) => q.neq("status", "a"))).toEqual([
      "valor-diferente",
    ]);
  });

  it(".is(col, null) casa só NULL explícito (convenção do mock)", async () => {
    expect(await ids(rows, (q) => q.is("status", null))).toEqual(["nulo"]);
  });

  it(".eq continua descartando NULL e coluna ausente", async () => {
    expect(await ids(rows, (q) => q.eq("status", "b"))).toEqual([
      "valor-diferente",
    ]);
  });

  it(".in continua descartando NULL e coluna ausente", async () => {
    expect(await ids(rows, (q) => q.in("status", ["a", "b"]))).toEqual([
      "valor-igual",
      "valor-diferente",
    ]);
  });
});

describe("makeFilterAwareSupabaseMock: NULL nos filtros de igualdade", () => {
  const rows = [{ id: "nulo", status: null }, { id: "valor", status: "a" }];

  it(".eq(col, null) não casa nada (col = NULL nunca é verdadeiro)", async () => {
    expect(await ids(rows, (q) => q.eq("status", null))).toEqual([]);
  });

  it("null dentro de .in não casa a linha NULL", async () => {
    expect(await ids(rows, (q) => q.in("status", ["a", null]))).toEqual(["valor"]);
  });
});

// O PostgREST recusa `.single()` sem exatamente uma linha e `.maybeSingle()`
// com mais de uma (PGRST116); o mock que devolvia `data: null` sem erro
// escondia o caminho de erro de quem lê.
describe("makeFilterAwareSupabaseMock: .single() e .maybeSingle()", () => {
  type Single = Promise<{ data: unknown; error: { code: string } | null }>;
  type Q = { eq(c: string, v: unknown): Q; single(): Single; maybeSingle(): Single };
  const query = (rows: unknown[]) =>
    (makeFilterAwareSupabaseMock({ tableData: { t: rows }, writeCalls: [] }).from("t") as unknown as {
      select(c: string): Q;
    }).select("id");
  const two = [{ id: "a", k: 1 }, { id: "b", k: 1 }];

  it(".single() com uma linha devolve a linha", async () => {
    expect(await query(two).eq("id", "a").single()).toEqual({ data: { id: "a", k: 1 }, error: null });
  });

  it(".single() com zero ou duas linhas devolve PGRST116", async () => {
    for (const q of [query(two).eq("id", "x"), query(two).eq("k", 1)]) {
      const { data, error } = await q.single();
      expect(data).toBeNull();
      expect(error?.code).toBe("PGRST116");
    }
  });

  it(".maybeSingle() com zero linhas é null sem erro; com duas, PGRST116", async () => {
    expect(await query(two).eq("id", "x").maybeSingle()).toEqual({ data: null, error: null });
    expect((await query(two).eq("k", 1).maybeSingle()).error?.code).toBe("PGRST116");
  });
});

describe("makeFilterAwareSupabaseMock: escritas", () => {
  type W = PromiseLike<{ error: { code: string } | null }> & { eq(c: string, v: unknown): W };
  const client = (writeCalls: WriteCall[]) =>
    makeFilterAwareSupabaseMock({ tableData: { t: [] }, writeCalls }).from("t") as unknown as {
      update(p: unknown): W;
      delete(): W;
      insert(p: unknown): W;
    };

  it("UPDATE e DELETE sem filtro são recusados, como o safeupdate do Supabase", async () => {
    const writeCalls: WriteCall[] = [];
    expect((await client(writeCalls).update({ a: 1 })).error?.code).toBe("21000");
    expect((await client(writeCalls).delete()).error?.code).toBe("21000");
    expect((await client(writeCalls).insert({ a: 1 })).error).toBeNull();
  });

  it("a escrita registra os filtros", async () => {
    const writeCalls: WriteCall[] = [];
    expect((await client(writeCalls).update({ a: 1 }).eq("id", "x")).error).toBeNull();
    expect(writeCalls).toEqual([
      { table: "t", op: "update", payload: { a: 1 }, filters: [["eq", "id", "x"]] },
    ]);
  });

  it("insert seguido de .single() devolve a linha escrita", async () => {
    const writeCalls: WriteCall[] = [];
    const table = makeFilterAwareSupabaseMock({
      tableData: { t: [{ id: "existente" }, { id: "outra" }] },
      writeCalls,
    }).from("t") as unknown as {
      insert(p: unknown): { select(c: string): { single(): Promise<{ data: unknown; error: unknown }> } };
    };
    expect(await table.insert({ id: "nova" }).select("id").single()).toEqual({
      data: { id: "nova" },
      error: null,
    });
  });
});
