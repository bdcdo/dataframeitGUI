// Mock chainable filter-aware do client Supabase, compartilhado pelos testes
// do cluster retry/comparison (arbitration-retry, comparisons-retry,
// auto-comparison, compare-sync, entre outros). Extraído dos mocks duplicados
// desses arquivos (#387). Não é coletado pelo vitest (include cobre apenas
// *.test.ts). Não confundir com `actions/__tests__/supabase-mock.ts`
// (`makeSupabaseMock`), que resolve por nome de tabela e não filtra. A direção
// registrada (#686) é migrar os testes que usam mocks cegos a filtro para
// este motor, um arquivo por vez.

export type WriteCall = { table: string; op: string; payload: unknown };
export type RpcCall = { fn: string; args: unknown };
export type RpcResult = {
  data?: unknown;
  error?: { message: string; code?: string } | null;
};

export type QueryError = {
  message: string;
  code?: string;
};

// Factories canônicos dos módulos mockados. Manter o shape aqui evita que cada
// teste replique o mesmo par createSupabaseServer/createSupabaseAdmin; `onCreate`
// preserva os casos que também verificam se a service role chegou a ser criada.
export function makeSupabaseServerModuleMock<T>(createClient: () => T) {
  return { createSupabaseServer: async () => createClient() };
}

export function makeSupabaseAdminModuleMock<T>(
  createClient: () => T,
  onCreate?: () => void,
) {
  return {
    createSupabaseAdmin: () => {
      onCreate?.();
      return createClient();
    },
  };
}

export function callsOf(
  writeCalls: WriteCall[],
  op: string,
  table?: string,
): WriteCall[] {
  return writeCalls.filter((c) => c.op === op && (!table || c.table === table));
}

// Mock filter-aware: aplica eq/neq/is/in/limit/range às linhas de state.tableData[table]
// e registra writes em state.writeCalls. Linha sem a coluna filtrada não passa
// em .eq/.neq/.is/.in (`.is(c, null)` exige `c: null` explícito), então cada
// linha do teste declara as colunas que a query filtra. O .neq também descarta
// `c: null`, como o Postgres (`null <> x` é NULL, não verdadeiro).
// `state` deve ser passado como objeto fresco a cada chamada de makeClient()
// local (não memoizar), para sempre refletir os valores atuais de
// `let tableData`/`let writeCalls` do arquivo de teste — que são reatribuídos
// por inteiro no beforeEach.
export function makeFilterAwareSupabaseMock(state: {
  tableData: Record<string, unknown[]>;
  writeCalls: WriteCall[];
  rpcCalls?: RpcCall[];
  rpcResults?: Record<string, RpcResult>;
  queryErrors?: Record<string, QueryError | null>;
}) {
  return {
    rpc: (fn: string, args: unknown) => {
      state.rpcCalls?.push({ fn, args });
      const result = state.rpcResults?.[fn];
      return {
        then: (resolve: (value: unknown) => unknown) =>
          resolve({ data: result?.data ?? null, error: result?.error ?? null }),
      };
    },
    from: (table: string) => {
      const eqs: Array<[string, unknown]> = [];
      const neqs: Array<[string, unknown]> = [];
      const ins: Array<[string, unknown[]]> = [];
      // Última operação do builder: compõe a chave de erro de `queryErrors`.
      let op = "select";
      let limitN: number | null = null;
      let rangeN: [number, number] | null = null;
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      // Ordem: as linhas já saem na ordem de `tableData`, que o teste controla.
      builder.order = () => builder;
      builder.range = (from: number, to: number) => {
        rangeN = [from, to];
        return builder;
      };
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
      for (const write of ["update", "upsert", "insert", "delete"]) {
        // delete() não tem payload; o argumento opcional ({ count }) é opção.
        builder[write] = (payload: unknown) => {
          state.writeCalls.push({
            table,
            op: write,
            payload: write === "delete" ? null : payload,
          });
          op = write;
          return builder;
        };
      }
      const rows = () => {
        const data = (state.tableData[table] ?? []) as Array<
          Record<string, unknown>
        >;
        const filtered = data.filter((r) => {
          for (const [c, v] of eqs) if (r[c] !== v) return false;
          for (const [c, v] of neqs) if (r[c] == null || r[c] === v) return false;
          for (const [c, vals] of ins) if (!vals.includes(r[c])) return false;
          return true;
        });
        const ranged = rangeN ? filtered.slice(rangeN[0], rangeN[1] + 1) : filtered;
        return limitN != null ? ranged.slice(0, limitN) : ranged;
      };
      const err = () => state.queryErrors?.[`${table}:${op}`] ?? null;
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
