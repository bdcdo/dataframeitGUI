// Mock chainable filter-aware do client Supabase, compartilhado pelos testes
// do cluster retry/comparison (arbitration-retry, comparisons-retry,
// auto-comparison, compare-sync, entre outros). Extraído dos mocks duplicados
// desses arquivos (#387). Não é coletado pelo vitest (include cobre apenas
// *.test.ts). Não confundir com `actions/__tests__/supabase-mock.ts`
// (`makeSupabaseMock`), que resolve por nome de tabela e não filtra. A direção
// registrada (#686) é migrar os testes que usam mocks cegos a filtro para
// este motor, um arquivo por vez.

// `filters`: os filtros da escrita (eq/neq/is/not.is/in; `.match` vira um eq
// por chave), no mock filter-aware, para o teste conferir quais linhas ela
// alcançaria.
export type WriteCall = {
  table: string;
  op: string;
  payload: unknown;
  filters?: Array<[string, string, unknown]>;
};
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

// Mock filter-aware: aplica eq/neq/is/not.is/in/match/limit/range às linhas de state.tableData[table]
// e registra writes em state.writeCalls. Linha sem a coluna filtrada não passa
// em .eq/.neq/.is/.in (`.is(c, null)` exige `c: null` explícito), então cada
// linha do teste declara as colunas que a query filtra (`.not(c, "is", null)`
// também: a linha sem `c` não passa, e a que não tem o valor declara `c: null`).
// Caminho JSON e coluna de embed são chaves literais da linha
// (`"answers->q1"`, `"documents.excluded_at"`). O .neq também descarta
// `c: null`, como o Postgres (`null <> x` é NULL, não verdadeiro), e o mesmo
// vale para `.eq(c, null)` e para o null dentro de `.in`: `c = NULL` nunca é
// verdadeiro; NULL se pede com `.is(c, null)`.
//
// Como o PostgREST, `.single()` com zero ou mais de uma linha devolve o erro
// PGRST116, e `.maybeSingle()` com mais de uma também; e UPDATE ou DELETE sem
// filtro é recusado (o `safeupdate` do Supabase, código 21000). Cada escrita
// registra os filtros em `filters`.
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
      // `.order()` e `.range()`, para a RPC que devolve tabela e é paginada por
      // `fetchAllPaged`: a ordem é a do array do teste.
      let rangeN: [number, number] | null = null;
      const call: Record<string, unknown> = {
        order: () => call,
        range: (from: number, to: number) => {
          rangeN = [from, to];
          return call;
        },
        then: (resolve: (value: unknown) => unknown) => {
          const error = result?.error ?? null;
          const data = error ? null : (result?.data ?? null);
          const paged =
            rangeN && Array.isArray(data) ? data.slice(rangeN[0], rangeN[1] + 1) : data;
          return resolve({ data: paged, error });
        },
      };
      return call;
    },
    from: (table: string) => {
      // Os filtros na ordem das chamadas: é a ordem que `write.filters` registra.
      const filterList: Array<[string, string, unknown]> = [];
      let write: WriteCall | null = null;
      // Última operação do builder: compõe a chave de erro de `queryErrors`.
      let op = "select";
      let limitN: number | null = null;
      let rangeN: [number, number] | null = null;
      // Os `alias:coluna` do select (o caminho JSON incluso), copiados para a
      // linha devolvida quando ela tem a chave `coluna`. Embed e coluna sem
      // alias não mudam a linha: o mock não projeta colunas.
      let aliases: Array<[string, string]> = [];
      const builder: Record<string, unknown> = {};
      builder.select = (columns?: string) => {
        aliases = [...(columns ?? "").matchAll(/(?:^|,)\s*(\w+):([\w.]+(?:->>?\w+)*)\s*(?=,|$)/g)].map(
          (m) => [m[1], m[2]],
        );
        return builder;
      };
      // Ordem: as linhas já saem na ordem de `tableData`, que o teste controla.
      builder.order = () => builder;
      builder.range = (from: number, to: number) => {
        rangeN = [from, to];
        return builder;
      };
      for (const kind of ["eq", "neq", "is", "in"]) {
        builder[kind] = (c: string, v: unknown) => {
          filterList.push([kind, c, v]);
          return builder;
        };
      }
      // `.match({ c: v, ... })`: um `.eq` por chave, e a chave `undefined` sai
      // do filtro, como no postgrest-js (sem filtro nenhum, o UPDATE ou DELETE
      // cai no 21000).
      builder.match = (query: Record<string, unknown>) => {
        for (const [c, v] of Object.entries(query)) if (v !== undefined) filterList.push(["eq", c, v]);
        return builder;
      };
      // `.not(c, "is", v)`: `NOT (c IS v)`. É o único operador do `.not` que a
      // produção usa; outro falha alto, em vez de virar filtro que não filtra.
      builder.not = (c: string, operator: string, v: unknown) => {
        if (operator !== "is") throw new Error(`mock: .not(_, "${operator}") não suportado`);
        filterList.push(["not.is", c, v]);
        return builder;
      };
      // Só tipagem no supabase-js.
      builder.returns = () => builder;
      builder.limit = (n: number) => {
        limitN = n;
        return builder;
      };
      for (const writeOp of ["update", "upsert", "insert", "delete"]) {
        // delete() não tem payload; o argumento opcional ({ count }) é opção.
        builder[writeOp] = (payload: unknown) => {
          // Os filtros vêm depois no encadeamento; o registro é o mesmo objeto,
          // e `filters` é lido na resolução.
          write = {
            table,
            op: writeOp,
            payload: writeOp === "delete" ? null : payload,
          };
          state.writeCalls.push(write);
          op = writeOp;
          return builder;
        };
      }
      // `col = NULL` e `NULL IN (...)` nunca são verdadeiros; `col <> x` com
      // `col` NULL também não. `.is(c, null)` exige `c: null` explícito.
      const passes = (r: Record<string, unknown>, [kind, c, v]: [string, string, unknown]) => {
        if (kind === "is") return c in r && r[c] === v;
        if (kind === "not.is") return c in r && r[c] !== v;
        if (r[c] == null) return false;
        if (kind === "eq") return r[c] === v;
        if (kind === "neq") return r[c] !== v;
        return (v as unknown[]).includes(r[c]);
      };
      const rows = () => {
        const data = (state.tableData[table] ?? []) as Array<
          Record<string, unknown>
        >;
        const filtered = data.filter((r) => filterList.every((f) => passes(r, f)));
        const ranged = rangeN ? filtered.slice(rangeN[0], rangeN[1] + 1) : filtered;
        const limited = limitN != null ? ranged.slice(0, limitN) : ranged;
        if (aliases.length === 0) return limited;
        return limited.map((r) => {
          const projected = { ...r };
          for (const [alias, c] of aliases) if (c in r) projected[alias] = r[c];
          return projected;
        });
      };
      const unfilteredWrite = () =>
        (op === "update" || op === "delete") && filterList.length === 0
          ? { code: "21000", message: `${op.toUpperCase()} requires a WHERE clause` }
          : null;
      const err = () => {
        if (write) write.filters = [...filterList];
        return state.queryErrors?.[`${table}:${op}`] ?? unfilteredWrite();
      };
      const notOneRow = (count: number) => ({
        code: "PGRST116",
        message: `JSON object requested, multiple (or no) rows returned (${count})`,
      });
      // `insert/upsert(...).select().single()` devolve a linha escrita, e não
      // uma linha da tabela.
      const singleRows = () =>
        op === "insert" || op === "upsert"
          ? [write?.payload].flat().filter((row) => row != null)
          : rows();
      builder.single = () => {
        const found = singleRows();
        const error = err() ?? (found.length === 1 ? null : notOneRow(found.length));
        return Promise.resolve({ data: error ? null : found[0], error });
      };
      builder.maybeSingle = () => {
        const found = singleRows();
        const error = err() ?? (found.length > 1 ? notOneRow(found.length) : null);
        return Promise.resolve({ data: error ? null : (found[0] ?? null), error });
      };
      builder.then = (resolve: (v: unknown) => unknown) => {
        const error = err();
        return resolve({ data: error ? null : rows(), error });
      };
      return builder;
    },
  };
}
