import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PydanticField } from "@/lib/types";

// Mock supabase chainable e FILTER-AWARE: diferente do mock de
// arbitration-retry.test.ts, aplica os filtros .eq/.neq/.in às linhas, porque a
// comparação consulta `responses` duas vezes na mesma chamada (humano vs LLM) —
// um mock que ignora filtros devolveria o mesmo array para ambas.
type WriteCall = { table: string; op: string; payload: unknown };
let writeCalls: WriteCall[];
let tableData: Record<string, unknown[]>;

const upsertCallsOf = (table?: string) =>
  writeCalls.filter((c) => c.op === "upsert" && (!table || c.table === table));
const deleteCallsOf = (table?: string) =>
  writeCalls.filter((c) => c.op === "delete" && (!table || c.table === table));

function makeClient() {
  return {
    from: (table: string) => {
      const eqs: Array<[string, unknown]> = [];
      const neqs: Array<[string, unknown]> = [];
      const ins: Array<[string, unknown[]]> = [];
      let op = "select";
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
      builder.update = (payload: unknown) => {
        writeCalls.push({ table, op: "update", payload });
        op = "update";
        return builder;
      };
      builder.upsert = (payload: unknown) => {
        writeCalls.push({ table, op: "upsert", payload });
        op = "upsert";
        return builder;
      };
      builder.insert = (payload: unknown) => {
        writeCalls.push({ table, op: "insert", payload });
        op = "insert";
        return builder;
      };
      builder.delete = () => {
        writeCalls.push({ table, op: "delete", payload: null });
        op = "delete";
        return builder;
      };

      const rows = () => {
        const data = (tableData[table] ?? []) as Array<Record<string, unknown>>;
        const filtered = data.filter((r) => {
          for (const [c, v] of eqs) if (r[c] !== v) return false;
          for (const [c, v] of neqs) if (r[c] === v) return false;
          for (const [c, vals] of ins) if (!vals.includes(r[c])) return false;
          return true;
        });
        return limitN != null ? filtered.slice(0, limitN) : filtered;
      };
      const err = () => tableData[`__error:${table}:${op}`] ?? null;

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

const hoisted = vi.hoisted(() => ({
  isCoord: vi.fn<() => Promise<boolean>>(async () => true),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({
  getAuthUser: async () => ({ id: "userCoord" }),
  isProjectCoordinator: () => hoisted.isCoord(),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdmin: () => makeClient(),
}));

const FIELDS: PydanticField[] = [
  { name: "q1", type: "text", options: null, description: "", required: true },
];

// Hash do schema corrente do projeto. As fixtures default usam-no como
// `pydantic_hash`, com semver NULL, para qualificar pelo fallback de hash em
// `responseQualifiesForVersion` sob o piso vivo `latest_major` (#247). Casos de
// versão antiga passam `pydantic_hash: "hash-antigo"` ou um semver < piso.
const CURRENT_HASH = "hash-atual";

// Helpers de fixture. Campos de versão (pydantic_hash, schema_version_*) entram
// no shape porque o gatilho agora aplica o piso `latest_major` antes de medir
// divergência (#247). Default = versão corrente (qualifica); `extra` sobrescreve
// para emular rodadas antigas. Semver explícito como NULL (não undefined) para
// espelhar o que o Postgres devolve em respostas pré-versionamento.
const human = (
  respondent_id: string,
  q1: string,
  extra: Record<string, unknown> = {},
) => ({
  id: `r-${respondent_id}`,
  project_id: "p1",
  document_id: "doc1",
  respondent_id,
  respondent_type: "humano",
  is_latest: true,
  answers: { q1 },
  answer_field_hashes: null,
  pydantic_hash: CURRENT_HASH,
  schema_version_major: null,
  schema_version_minor: null,
  schema_version_patch: null,
  ...extra,
});
const llm = (q1: string, extra: Record<string, unknown> = {}) => ({
  id: "r-llm",
  project_id: "p1",
  document_id: "doc1",
  respondent_type: "llm",
  is_latest: true,
  answers: { q1 },
  answer_field_hashes: null,
  pydantic_hash: CURRENT_HASH,
  schema_version_major: null,
  schema_version_minor: null,
  schema_version_patch: null,
  ...extra,
});
const member = (user_id: string) => ({
  user_id,
  project_id: "p1",
  can_compare: true,
});
const projectRow = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  pydantic_fields: FIELDS,
  pydantic_hash: CURRENT_HASH,
  min_responses_for_comparison: 2,
  comparison_includes_llm: true,
  automation_mode: "compare_humans",
  // Sem semver explícito: cai nos fallbacks {0,1,0} (como page.tsx/compare-sync),
  // e o piso `latest_major` ancora em {0,1,0}. Casos que exercitam o caminho
  // semver passam schema_version_* aqui.
  schema_version_major: null,
  schema_version_minor: null,
  schema_version_patch: null,
  ...over,
});

beforeEach(() => {
  writeCalls = [];
  tableData = {
    projects: [projectRow()],
    project_members: [],
    assignments: [],
    responses: [],
    response_equivalences: [],
  };
  hoisted.isCoord.mockResolvedValue(true);
});

async function loadLib() {
  return import("@/lib/auto-comparison");
}

describe("assignComparisonReviewer — pool e balanceamento", () => {
  it("exclui TODOS os codificadores do pool", async () => {
    const { assignComparisonReviewer } = await loadLib();
    tableData.project_members = [member("userA"), member("userB"), member("userC")];
    const r = await assignComparisonReviewer(
      makeClient() as never,
      "p1",
      "doc1",
      new Set(["userA", "userB"]), // codificadores
    );
    expect(r.assigned).toBe(true);
    expect(r.noPool).toBe(false);
    expect(upsertCallsOf("assignments")).toHaveLength(1);
    expect(upsertCallsOf("assignments")[0].payload).toMatchObject({
      user_id: "userC",
      type: "comparacao",
      status: "pendente",
    });
  });

  it("pool vazio (todos codificaram) → noPool, sem upsert", async () => {
    const { assignComparisonReviewer } = await loadLib();
    tableData.project_members = [member("userA"), member("userB")];
    const r = await assignComparisonReviewer(
      makeClient() as never,
      "p1",
      "doc1",
      new Set(["userA", "userB"]),
    );
    expect(r.noPool).toBe(true);
    expect(r.assigned).toBe(false);
    expect(upsertCallsOf("assignments")).toHaveLength(0);
  });

  it("ninguém can_compare → noPool", async () => {
    const { assignComparisonReviewer } = await loadLib();
    tableData.project_members = [];
    const r = await assignComparisonReviewer(
      makeClient() as never,
      "p1",
      "doc1",
      new Set(),
    );
    expect(r.noPool).toBe(true);
  });

  it("escolhe o revisor de menor carga de comparações abertas", async () => {
    const { assignComparisonReviewer } = await loadLib();
    tableData.project_members = [member("userB"), member("userC")];
    // userB já tem 2 comparações abertas; userC nenhuma → escolhe userC.
    tableData.assignments = [
      { user_id: "userB", project_id: "p1", type: "comparacao", status: "pendente" },
      { user_id: "userB", project_id: "p1", type: "comparacao", status: "em_andamento" },
    ];
    const r = await assignComparisonReviewer(
      makeClient() as never,
      "p1",
      "doc1",
      new Set(["userA"]),
    );
    expect(r.assigned).toBe(true);
    expect(upsertCallsOf("assignments")[0].payload).toMatchObject({
      user_id: "userC",
    });
  });
});

describe("createAutoComparisonIfDiverges — compare_humans", () => {
  it("2 humanos divergentes → atribui comparacao", async () => {
    const { createAutoComparisonIfDiverges } = await loadLib();
    tableData.responses = [human("userA", "A"), human("userB", "B")];
    tableData.project_members = [member("userC")];
    const r = await createAutoComparisonIfDiverges("p1", "doc1", "compare_humans");
    expect(r.assigned).toBe(true);
    expect(upsertCallsOf("assignments")).toHaveLength(1);
    expect(upsertCallsOf("assignments")[0].payload).toMatchObject({
      user_id: "userC",
      type: "comparacao",
    });
  });

  it("2 humanos em consenso → não atribui", async () => {
    const { createAutoComparisonIfDiverges } = await loadLib();
    tableData.responses = [human("userA", "A"), human("userB", "A")];
    tableData.project_members = [member("userC")];
    const r = await createAutoComparisonIfDiverges("p1", "doc1", "compare_humans");
    expect(r.assigned).toBe(false);
    expect(upsertCallsOf("assignments")).toHaveLength(0);
  });

  it("abaixo do mínimo (1 humano) → não dispara", async () => {
    const { createAutoComparisonIfDiverges } = await loadLib();
    tableData.responses = [human("userA", "A")];
    tableData.project_members = [member("userC")];
    const r = await createAutoComparisonIfDiverges("p1", "doc1", "compare_humans");
    expect(r.assigned).toBe(false);
    expect(upsertCallsOf("assignments")).toHaveLength(0);
  });

  it("codificação incompleta não conta para o mínimo", async () => {
    const { createAutoComparisonIfDiverges } = await loadLib();
    // userB tem resposta vazia (incompleta) → só 1 humano completo.
    tableData.responses = [
      human("userA", "A"),
      { ...human("userB", "B"), answers: {} },
    ];
    tableData.project_members = [member("userC")];
    const r = await createAutoComparisonIfDiverges("p1", "doc1", "compare_humans");
    expect(r.assigned).toBe(false);
  });

  it("já existe comparacao ativa → idempotente, não re-sorteia", async () => {
    const { createAutoComparisonIfDiverges } = await loadLib();
    tableData.responses = [human("userA", "A"), human("userB", "B")];
    tableData.project_members = [member("userC")];
    tableData.assignments = [
      { document_id: "doc1", project_id: "p1", type: "comparacao", status: "pendente" },
    ];
    const r = await createAutoComparisonIfDiverges("p1", "doc1", "compare_humans");
    expect(r.assigned).toBe(false);
    expect(upsertCallsOf("assignments")).toHaveLength(0);
  });

  it("comparison_includes_llm=true: humanos concordam mas LLM diverge → dispara", async () => {
    const { createAutoComparisonIfDiverges } = await loadLib();
    tableData.projects = [projectRow({ comparison_includes_llm: true })];
    tableData.responses = [human("userA", "A"), human("userB", "A"), llm("Z")];
    tableData.project_members = [member("userC")];
    const r = await createAutoComparisonIfDiverges("p1", "doc1", "compare_humans");
    expect(r.assigned).toBe(true);
  });

  it("comparison_includes_llm=false: humanos concordam e só LLM diverge → NÃO dispara", async () => {
    const { createAutoComparisonIfDiverges } = await loadLib();
    tableData.projects = [projectRow({ comparison_includes_llm: false })];
    tableData.responses = [human("userA", "A"), human("userB", "A"), llm("Z")];
    tableData.project_members = [member("userC")];
    const r = await createAutoComparisonIfDiverges("p1", "doc1", "compare_humans");
    expect(r.assigned).toBe(false);
  });
});

describe("createAutoComparisonIfDiverges — compare_llm", () => {
  it("1 humano + LLM divergentes → atribui comparacao", async () => {
    const { createAutoComparisonIfDiverges } = await loadLib();
    tableData.projects = [projectRow({ automation_mode: "compare_llm" })];
    tableData.responses = [human("userA", "A"), llm("B")];
    tableData.project_members = [member("userC")];
    const r = await createAutoComparisonIfDiverges("p1", "doc1", "compare_llm");
    expect(r.assigned).toBe(true);
    expect(upsertCallsOf("assignments")[0].payload).toMatchObject({
      user_id: "userC",
      type: "comparacao",
    });
  });

  it("1 humano + LLM em consenso → não dispara", async () => {
    const { createAutoComparisonIfDiverges } = await loadLib();
    tableData.projects = [projectRow({ automation_mode: "compare_llm" })];
    tableData.responses = [human("userA", "A"), llm("A")];
    tableData.project_members = [member("userC")];
    const r = await createAutoComparisonIfDiverges("p1", "doc1", "compare_llm");
    expect(r.assigned).toBe(false);
  });

  it("sem resposta do LLM → não dispara", async () => {
    const { createAutoComparisonIfDiverges } = await loadLib();
    tableData.projects = [projectRow({ automation_mode: "compare_llm" })];
    tableData.responses = [human("userA", "A")];
    tableData.project_members = [member("userC")];
    const r = await createAutoComparisonIfDiverges("p1", "doc1", "compare_llm");
    expect(r.assigned).toBe(false);
  });

  it("codificador do doc não entra no pool (LLM compara, mas humano que codificou não revisa)", async () => {
    const { createAutoComparisonIfDiverges } = await loadLib();
    tableData.projects = [projectRow({ automation_mode: "compare_llm" })];
    tableData.responses = [human("userA", "A"), llm("B")];
    // userA é o único can_compare, mas codificou o doc → noPool.
    tableData.project_members = [member("userA")];
    const r = await createAutoComparisonIfDiverges("p1", "doc1", "compare_llm");
    expect(r.assigned).toBe(false);
    expect(r.noPool).toBe(true);
  });
});

// O gatilho aplica o MESMO piso de versão (`latest_major`) que a fila
// (compare/page.tsx) e o fecho (compare-sync.ts) — fecha a NOTA de follow-up do
// #286 e restaura o acoplamento gatilho==fila==fecho. Divergência que só existe
// entre rodadas antigas NÃO materializa assignment (era o "fantasma" da NOTA).
describe("createAutoComparisonIfDiverges — piso de versão latest_major (#247)", () => {
  it("divergência só entre codificações de versão ANTIGA (hash) não materializa", async () => {
    const { createAutoComparisonIfDiverges } = await loadLib();
    // Dois humanos completos que DIVERGEM, mas ambos de um schema anterior
    // (pydantic_hash != atual, semver NULL) → descartados pelo piso → 0 < 2.
    tableData.responses = [
      human("userA", "A", { pydantic_hash: "hash-antigo" }),
      human("userB", "B", { pydantic_hash: "hash-antigo" }),
    ];
    tableData.project_members = [member("userC")];
    const r = await createAutoComparisonIfDiverges("p1", "doc1", "compare_humans");
    expect(r.assigned).toBe(false);
    expect(upsertCallsOf("assignments")).toHaveLength(0);
  });

  it("divergência só entre codificações de MAJOR anterior (semver) não materializa", async () => {
    const { createAutoComparisonIfDiverges } = await loadLib();
    // Projeto na major 2; respostas divergentes da major 1 → abaixo do piso.
    tableData.projects = [
      projectRow({ schema_version_major: 2, schema_version_minor: 0, schema_version_patch: 0 }),
    ];
    tableData.responses = [
      human("userA", "A", { schema_version_major: 1, schema_version_minor: 0, schema_version_patch: 0 }),
      human("userB", "B", { schema_version_major: 1, schema_version_minor: 0, schema_version_patch: 0 }),
    ];
    tableData.project_members = [member("userC")];
    const r = await createAutoComparisonIfDiverges("p1", "doc1", "compare_humans");
    expect(r.assigned).toBe(false);
    expect(upsertCallsOf("assignments")).toHaveLength(0);
  });

  it("divergência na MAJOR corrente ainda materializa (semver)", async () => {
    const { createAutoComparisonIfDiverges } = await loadLib();
    tableData.projects = [
      projectRow({ schema_version_major: 2, schema_version_minor: 0, schema_version_patch: 0 }),
    ];
    tableData.responses = [
      human("userA", "A", { schema_version_major: 2, schema_version_minor: 0, schema_version_patch: 0 }),
      human("userB", "B", { schema_version_major: 2, schema_version_minor: 0, schema_version_patch: 0 }),
    ];
    tableData.project_members = [member("userC")];
    const r = await createAutoComparisonIfDiverges("p1", "doc1", "compare_humans");
    expect(r.assigned).toBe(true);
    expect(upsertCallsOf("assignments")).toHaveLength(1);
  });

  it("mistura: 1 corrente + 1 antiga divergem → antiga descartada, sobra 1 < mínimo", async () => {
    const { createAutoComparisonIfDiverges } = await loadLib();
    tableData.responses = [
      human("userA", "A"), // corrente (hash atual)
      human("userB", "B", { pydantic_hash: "hash-antigo" }), // antiga
    ];
    tableData.project_members = [member("userC")];
    const r = await createAutoComparisonIfDiverges("p1", "doc1", "compare_humans");
    expect(r.assigned).toBe(false);
    expect(upsertCallsOf("assignments")).toHaveLength(0);
  });

  it("compare_llm: humano corrente diverge de LLM de schema antigo → LLM descartado, sem 2ª resposta", async () => {
    const { createAutoComparisonIfDiverges } = await loadLib();
    tableData.projects = [projectRow({ automation_mode: "compare_llm" })];
    tableData.responses = [
      human("userA", "A"),
      llm("B", { pydantic_hash: "hash-antigo" }),
    ];
    tableData.project_members = [member("userC")];
    const r = await createAutoComparisonIfDiverges("p1", "doc1", "compare_llm");
    // LLM antigo não qualifica → falta a 2ª resposta → não dispara.
    expect(r.assigned).toBe(false);
    expect(upsertCallsOf("assignments")).toHaveLength(0);
  });
});

describe("scanComparisonBacklog — piso de versão latest_major (#247)", () => {
  it("doc cuja divergência só existe em versão antiga fica fora do backlog", async () => {
    const { scanComparisonBacklog } = await loadLib();
    tableData.responses = [
      human("userA", "A", { pydantic_hash: "hash-antigo" }),
      human("userB", "B", { pydantic_hash: "hash-antigo" }),
    ];
    const backlog = await scanComparisonBacklog(
      makeClient() as never,
      "p1",
      "compare_humans",
    );
    expect(backlog).toHaveLength(0);
  });

  it("doc divergente na versão corrente entra no backlog", async () => {
    const { scanComparisonBacklog } = await loadLib();
    tableData.responses = [human("userA", "A"), human("userB", "B")];
    const backlog = await scanComparisonBacklog(
      makeClient() as never,
      "p1",
      "compare_humans",
    );
    expect(backlog).toHaveLength(1);
    expect(backlog[0].documentId).toBe("doc1");
  });
});

describe("releaseComparisonsFromUser", () => {
  it("deleta comparacao pendente do usuário", async () => {
    const { releaseComparisonsFromUser } = await loadLib();
    tableData.assignments = [
      { id: "a1", project_id: "p1", user_id: "userX", type: "comparacao", status: "pendente" },
      { id: "a2", project_id: "p1", user_id: "userX", type: "comparacao", status: "em_andamento" },
    ];
    const r = await releaseComparisonsFromUser(makeClient() as never, "p1", "userX");
    // só a pendente é contada (o filtro status=pendente exclui em_andamento)
    expect(r.released).toBe(1);
    expect(deleteCallsOf("assignments")).toHaveLength(1);
  });

  it("nada pendente → released 0", async () => {
    const { releaseComparisonsFromUser } = await loadLib();
    tableData.assignments = [];
    const r = await releaseComparisonsFromUser(makeClient() as never, "p1", "userX");
    expect(r.released).toBe(0);
  });
});
