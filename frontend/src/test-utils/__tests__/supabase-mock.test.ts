import { describe, expect, it } from "vitest";
import { makeFilterAwareSupabaseMock, type ReadCall, type WriteCall } from "../supabase-mock";

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
  not(c: string, op: string, v: unknown): Query;
  single(): Promise<unknown>;
  maybeSingle(): Promise<unknown>;
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

describe("makeFilterAwareSupabaseMock: .not(col, \"is\", v)", () => {
  const rows = [
    { id: "valor", status: "a" },
    { id: "nulo", status: null },
    { id: "coluna-ausente" },
  ];

  it("casa só a linha com valor não nulo (coluna ausente não passa, como nos outros filtros)", async () => {
    expect(await ids(rows, (q) => q.not("status", "is", null))).toEqual(["valor"]);
  });

  it("outro operador falha alto em vez de não filtrar", () => {
    const table = makeFilterAwareSupabaseMock({ tableData: { t: rows }, writeCalls: [] }).from("t") as unknown as {
      select(c: string): Query;
    };
    expect(() => table.select("id").not("status", "in", "(a)")).toThrow(/não suportado/);
  });
});

describe("makeFilterAwareSupabaseMock: projectColumns", () => {
  const read = async (columns: string, projectColumns?: boolean) => {
    const client = makeFilterAwareSupabaseMock({
      tableData: { t: [{ id: "a", nome: "x", extra: 1, "answers->q1": "v", documents: { title: "D" }, project_id: "p1" }] },
      writeCalls: [],
      projectColumns,
    });
    const table = client.from("t") as unknown as { select(c: string): Query };
    return (await table.select(columns).eq("project_id", "p1")).data;
  };

  it("devolve só coluna, alias e embed do select; o filtro vale sobre a linha inteira", async () => {
    expect(await read("id, valor:answers->q1, documents!inner(title, id)", true)).toEqual([
      { id: "a", valor: "v", documents: { title: "D" } },
    ]);
  });

  it("`*` devolve a linha inteira, e sem a opção nada muda", async () => {
    expect(await read("*", true)).toHaveLength(1);
    expect((await read("*", true))[0]).toHaveProperty("extra", 1);
    expect((await read("id", false))[0]).toHaveProperty("extra", 1);
  });
});

describe("makeFilterAwareSupabaseMock: max_rows", () => {
  it("leitura sem .range devolve só as primeiras 1000 linhas, mesmo com .limit maior; .range alcança o resto", async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({ id: `r${i}` }));
    const client = makeFilterAwareSupabaseMock({ tableData: { t: rows }, writeCalls: [] });
    type Paged = PromiseLike<{ data: unknown[] }> & {
      limit(n: number): PromiseLike<{ data: unknown[] }>;
      range(a: number, b: number): PromiseLike<{ data: unknown[] }>;
    };
    const select = () => (client.from("t") as unknown as { select(c: string): Paged }).select("id");
    expect((await select()).data).toHaveLength(1000);
    expect((await select().limit(5000)).data).toHaveLength(1000);
    expect((await select().range(1000, 1999)).data).toEqual([{ id: "r1000" }]);
  });
});

describe("makeFilterAwareSupabaseMock: readCalls", () => {
  it("registra colunas e filtros de cada leitura resolvida, inclusive com erro, e não as escritas", async () => {
    const readCalls: ReadCall[] = [];
    const client = makeFilterAwareSupabaseMock({
      tableData: { t: [{ id: "a" }] },
      writeCalls: [],
      readCalls,
      queryErrors: { "u:select": { message: "boom" } },
    });
    const from = (table = "t") =>
      client.from(table) as unknown as { select(c: string): Query; update(p: unknown): Query };
    await from().select("id, nome").eq("id", "a").single();
    await from().select("id").in("id", ["a", "b"]);
    await from().select("id").is("id", null).maybeSingle();
    await from("u").select("id");
    await from().update({ x: 1 }).eq("id", "a");
    expect(readCalls).toEqual([
      { table: "t", columns: "id, nome", filters: [["eq", "id", "a"]] },
      { table: "t", columns: "id", filters: [["in", "id", ["a", "b"]]] },
      { table: "t", columns: "id", filters: [["is", "id", null]] },
      { table: "u", columns: "id", filters: [] },
    ]);
  });
});

describe("makeFilterAwareSupabaseMock: alias do select", () => {
  it("copia `alias:coluna` (caminho JSON incluso) da chave literal da linha; embed não muda a linha", async () => {
    const table = makeFilterAwareSupabaseMock({
      tableData: { t: [{ id: "a", "answers->q1": "x" }, { id: "b" }] },
      writeCalls: [],
    }).from("t") as unknown as { select(c: string): PromiseLike<{ data: unknown[] }> };
    const { data } = await table.select("id, value:answers->q1, outro:answers->>q1, docs:documents!inner(title, id)");
    expect(data).toEqual([{ id: "a", "answers->q1": "x", value: "x" }, { id: "b" }]);
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

describe("makeFilterAwareSupabaseMock: .single() e .maybeSingle() na RPC", () => {
  type Single = Promise<{ data: unknown; error: { code?: string; message: string } | null }>;
  const rpc = (data: unknown, error: { message: string } | null = null) =>
    makeFilterAwareSupabaseMock({ tableData: {}, writeCalls: [], rpcResults: { f: { data, error } } }).rpc(
      "f",
      {},
    ) as unknown as { single(): Single; maybeSingle(): Single };

  it("linha (objeto) ou escalar é uma linha; array de uma linha devolve a linha", async () => {
    expect(await rpc({ status: "saved" }).single()).toEqual({ data: { status: "saved" }, error: null });
    expect(await rpc("p1").single()).toEqual({ data: "p1", error: null });
    expect(await rpc([{ id: "a" }]).maybeSingle()).toEqual({ data: { id: "a" }, error: null });
  });

  it("null é uma linha nula; array vazio é zero linhas (.single() dá PGRST116); duas, PGRST116 nos dois", async () => {
    expect(await rpc(null).single()).toEqual({ data: null, error: null });
    expect((await rpc([]).single()).error?.code).toBe("PGRST116");
    expect(await rpc([]).maybeSingle()).toEqual({ data: null, error: null });
    expect((await rpc([{ id: "a" }, { id: "b" }]).maybeSingle()).error?.code).toBe("PGRST116");
  });

  it("RPC sem entrada em rpcResults falha alto", () => {
    const call = makeFilterAwareSupabaseMock({ tableData: {}, writeCalls: [] }).rpc("g", {}) as unknown as {
      single(): unknown;
    };
    expect(() => call.single()).toThrow(/rpcResults sem "g"/);
  });

  it("erro da RPC passa com data null", async () => {
    expect(await rpc({ status: "saved" }, { message: "boom" }).single()).toEqual({
      data: null,
      error: { message: "boom" },
    });
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

  it(".match vira um .eq por chave, registrado na escrita, e a chave undefined sai do filtro", async () => {
    const writeCalls: WriteCall[] = [];
    const client = makeFilterAwareSupabaseMock({
      tableData: { t: [{ id: "a", k: 1 }, { id: "b", k: 2 }] },
      writeCalls,
    });
    const update = (q: Record<string, unknown>) =>
      (client.from("t") as unknown as {
        update(p: unknown): { match(q: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };
      }).update({ x: 1 }).match(q);
    expect(await update({ id: "a", k: 1 })).toEqual({ data: [{ id: "a", k: 1 }], error: null });
    expect(writeCalls[0].filters).toEqual([["eq", "id", "a"], ["eq", "k", 1]]);
    expect(await update({ id: undefined })).toMatchObject({ data: null, error: { code: "21000" } });
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
