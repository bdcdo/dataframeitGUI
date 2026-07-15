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
  op: "update" | "insert" | "delete" | "upsert";
  payload: unknown;
};

export type RpcCall = {
  fn: string;
  args: unknown;
};

export type FilterCall = {
  table: string;
  method: string;
  args: unknown[];
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
  filterCalls?: FilterCall[];
  rpcCalls?: RpcCall[];
  rpcResults?: Record<string, TableResult>;
}) {
  const {
    tableResults,
    defaultResult,
    writeCalls,
    filterCalls,
    rpcCalls,
    rpcResults,
  } = opts ?? {};
  return {
    // rpc(): registra a chamada e resolve { data, error } como o thenable das
    // queries. Resultado por função em `rpcResults`; sem entrada, sucesso vazio.
    rpc: (fn: string, args: unknown) => {
      rpcCalls?.push({ fn, args });
      const result = rpcResults?.[fn];
      return {
        then: (resolve: (v: unknown) => unknown) =>
          resolve({
            data: result?.data ?? null,
            error: result?.error ?? null,
          }),
      };
    },
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      for (const m of [
        "eq",
        "is",
        "in",
        "neq",
        "match",
        "select",
        "single",
        "maybeSingle",
        "order",
        "limit",
        "range",
      ]) {
        builder[m] = (...args: unknown[]) => {
          filterCalls?.push({ table, method: m, args });
          return builder;
        };
      }
      builder.update = (payload: unknown) => {
        writeCalls?.push({ table, op: "update", payload });
        return builder;
      };
      builder.insert = (payload: unknown) => {
        writeCalls?.push({ table, op: "insert", payload });
        return builder;
      };
      builder.upsert = (payload: unknown) => {
        writeCalls?.push({ table, op: "upsert", payload });
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
