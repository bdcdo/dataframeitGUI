// Mocks chainable do client Supabase compartilhados entre os testes do
// cluster retry/comparison (arbitration-retry, comparisons-retry,
// auto-comparison, compare-sync). Extraído dos mocks duplicados desses 4
// arquivos (#387). Não é coletado pelo vitest (include cobre apenas
// *.test.ts). Não confundir com `actions/__tests__/supabase-mock.ts`
// (`makeSupabaseMock`), que serve outro conjunto de testes e não é
// filter-aware — mantido separado de propósito.

export type WriteCall = { table: string; op: string; payload: unknown };
export type RpcCall = { fn: string; args: unknown };
export type RpcResult = {
  data?: unknown;
  error?: { message: string } | null;
};

function makeRpc(state: {
  rpcCalls?: RpcCall[];
  rpcResults?: Record<string, RpcResult>;
}) {
  return (fn: string, args: unknown) => {
    state.rpcCalls?.push({ fn, args });
    const result = state.rpcResults?.[fn];
    return {
      then: (resolve: (value: unknown) => unknown) =>
        resolve({ data: result?.data ?? null, error: result?.error ?? null }),
    };
  };
}

export function callsOf(
  writeCalls: WriteCall[],
  op: string,
  table?: string,
): WriteCall[] {
  return writeCalls.filter((c) => c.op === op && (!table || c.table === table));
}

// Rastreia a última operação de escrita (update/upsert/insert/delete) por
// referência mutável, para que os dois mocks abaixo possam expor o `op`
// corrente ao restante do builder (chave de erro, fallback de leitura) sem
// duplicar os quatro métodos de escrita entre si.
type OpRef = { current: string };

function attachWriteOps(
  builder: Record<string, unknown>,
  table: string,
  writeCalls: WriteCall[],
  opRef: OpRef,
) {
  builder.update = (payload: unknown) => {
    writeCalls.push({ table, op: "update", payload });
    opRef.current = "update";
    return builder;
  };
  builder.upsert = (payload: unknown) => {
    writeCalls.push({ table, op: "upsert", payload });
    opRef.current = "upsert";
    return builder;
  };
  builder.insert = (payload: unknown) => {
    writeCalls.push({ table, op: "insert", payload });
    opRef.current = "insert";
    return builder;
  };
  builder.delete = () => {
    writeCalls.push({ table, op: "delete", payload: null });
    opRef.current = "delete";
    return builder;
  };
}

// Mock filter-aware: aplica eq/neq/is/in/limit às linhas de state.tableData[table]
// e registra writes em state.writeCalls. Usado por comparisons-retry.test.ts,
// auto-comparison.test.ts e compare-sync.test.ts. `state` deve ser passado como
// objeto fresco a cada chamada de makeClient() local (não memoizar), para
// sempre refletir os valores atuais de `let tableData`/`let writeCalls` do
// arquivo de teste — que são reatribuídos por inteiro no beforeEach.
export function makeFilterAwareSupabaseMock(state: {
  tableData: Record<string, unknown[]>;
  writeCalls: WriteCall[];
  rpcCalls?: RpcCall[];
  rpcResults?: Record<string, RpcResult>;
}) {
  return {
    rpc: makeRpc(state),
    from: (table: string) => {
      const eqs: Array<[string, unknown]> = [];
      const neqs: Array<[string, unknown]> = [];
      const ins: Array<[string, unknown[]]> = [];
      const opRef: OpRef = { current: "select" };
      let limitN: number | null = null;
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = (c: string, v: unknown) => {
        eqs.push([c, v]);
        return builder;
      };
      builder.neq = (c: string, v: unknown) => {
        neqs.push([c, v]);
        return builder;
      };
      builder.is = (c: string, v: unknown) => {
        eqs.push([c, v]);
        return builder;
      };
      builder.in = (c: string, v: unknown[]) => {
        ins.push([c, v]);
        return builder;
      };
      builder.limit = (n: number) => {
        limitN = n;
        return builder;
      };
      attachWriteOps(builder, table, state.writeCalls, opRef);
      const rows = () => {
        const data = (state.tableData[table] ?? []) as Array<
          Record<string, unknown>
        >;
        const filtered = data.filter((r) => {
          for (const [c, v] of eqs) if (r[c] !== v) return false;
          for (const [c, v] of neqs) if (r[c] === v) return false;
          for (const [c, vals] of ins) if (!vals.includes(r[c])) return false;
          return true;
        });
        return limitN != null ? filtered.slice(0, limitN) : filtered;
      };
      const err = () => state.tableData[`__error:${table}:${opRef.current}`] ?? null;
      builder.single = () =>
        Promise.resolve({ data: rows()[0] ?? null, error: err() });
      builder.maybeSingle = () =>
        Promise.resolve({ data: rows()[0] ?? null, error: err() });
      builder.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: rows(), error: err() });
      return builder;
    },
  };
}

// Variante simples (ignora filtros .eq/.is/.in/.neq/.limit — resolve por
// chave de tabela inteira, com fallback para chave sufixada pela operação).
// Usada só por arbitration-retry.test.ts.
export function makeSimpleSupabaseMock(state: {
  tableData: Record<string, unknown>;
  writeCalls: WriteCall[];
  rpcCalls?: RpcCall[];
  rpcResults?: Record<string, RpcResult>;
}) {
  return {
    rpc: makeRpc(state),
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      const opRef: OpRef = { current: "select" };
      for (const m of ["select", "eq", "is", "in", "neq", "limit"]) {
        builder[m] = () => builder;
      }
      attachWriteOps(builder, table, state.writeCalls, opRef);
      builder.then = (resolve: (v: unknown) => unknown) =>
        resolve({
          data:
            state.tableData[`${table}:${opRef.current}`] ??
            state.tableData[table] ??
            null,
          error: state.tableData[`__error:${table}:${opRef.current}`] ?? null,
        });
      return builder;
    },
  };
}
