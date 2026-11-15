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
