// Mock chainable do client Supabase para testes de Server Actions, extraído
// dos mocks duplicados de members/schema/rounds.test.ts. Não é coletado pelo
// vitest (include cobre apenas *.test.ts).
//
// Builder: qualquer método de filtro/modificador devolve o próprio builder;
// update/insert/delete registram a chamada em `writeCalls`; o await (thenable)
// resolve com o resultado fixado por tabela em `tableResults` — um valor fixo
// ou uma fila (array) consumida na ordem das queries, necessária quando a
// action consulta a mesma tabela mais de uma vez com expectativas diferentes.
// Sem entrada para a tabela, vale `defaultResult` (ou data/error/count nulos).

export type WriteCall = {
  table: string;
  op: "update" | "insert" | "delete";
  payload: unknown;
};

export type TableResult = {
  data?: unknown;
  error?: { message: string; code?: string } | null;
  count?: number;
};

export type TableResults = Record<string, TableResult | TableResult[]>;

export function makeSupabaseMock(opts?: {
  tableResults?: TableResults;
  defaultResult?: TableResult;
  writeCalls?: WriteCall[];
}) {
  const { tableResults, defaultResult, writeCalls } = opts ?? {};
  return {
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      for (const m of [
        "eq", "is", "in", "neq", "match", "select", "single",
        "maybeSingle", "order", "limit", "range",
      ]) {
        builder[m] = () => builder;
      }
      builder.update = (payload: unknown) => {
        writeCalls?.push({ table, op: "update", payload });
        return builder;
      };
      builder.insert = (payload: unknown) => {
        writeCalls?.push({ table, op: "insert", payload });
        return builder;
      };
      builder.delete = () => {
        writeCalls?.push({ table, op: "delete", payload: null });
        return builder;
      };
      builder.then = (resolve: (v: unknown) => unknown) => {
        const entry = tableResults?.[table];
        const fixed = Array.isArray(entry) ? entry.shift() : entry;
        const result = fixed ?? defaultResult;
        return resolve({
          data: result?.data ?? null,
          error: result?.error ?? null,
          count: result?.count ?? null,
        });
      };
      return builder;
    },
  };
}
