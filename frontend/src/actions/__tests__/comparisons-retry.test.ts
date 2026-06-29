import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PydanticField } from "@/lib/types";

// Mock supabase filter-aware (mesmo padrão de lib/__tests__/auto-comparison.test.ts).
type WriteCall = { table: string; op: string; payload: unknown };
let writeCalls: WriteCall[];
let tableData: Record<string, unknown[]>;

const upsertCallsOf = (table?: string) =>
  writeCalls.filter((c) => c.op === "upsert" && (!table || c.table === table));

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
      builder.eq = (c: string, v: unknown) => (eqs.push([c, v]), builder);
      builder.neq = (c: string, v: unknown) => (neqs.push([c, v]), builder);
      builder.is = (c: string, v: unknown) => (eqs.push([c, v]), builder);
      builder.in = (c: string, v: unknown[]) => (ins.push([c, v]), builder);
      builder.limit = (n: number) => ((limitN = n), builder);
      builder.upsert = (payload: unknown) => {
        writeCalls.push({ table, op: "upsert", payload });
        op = "upsert";
        return builder;
      };
      builder.update = (payload: unknown) => {
        writeCalls.push({ table, op: "update", payload });
        op = "update";
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
      builder.single = () => Promise.resolve({ data: rows()[0] ?? null, error: err() });
      builder.maybeSingle = () => Promise.resolve({ data: rows()[0] ?? null, error: err() });
      builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows(), error: err() });
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
// Hash do schema corrente: o backlog (scanComparisonBacklog) aplica o piso vivo
// `latest_major` (#247), então as respostas precisam qualificar — usam o hash
// atual com semver NULL (caminho de fallback por hash em responseQualifiesForVersion).
const CURRENT_HASH = "hash-atual";
const human = (respondent_id: string, q1: string, document_id = "doc1") => ({
  id: `r-${respondent_id}-${document_id}`,
  project_id: "p1",
  document_id,
  respondent_id,
  respondent_type: "humano",
  is_latest: true,
  answers: { q1 },
  answer_field_hashes: null,
  pydantic_hash: CURRENT_HASH,
  schema_version_major: null,
  schema_version_minor: null,
  schema_version_patch: null,
});
const projectRow = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  pydantic_fields: FIELDS,
  pydantic_hash: CURRENT_HASH,
  min_responses_for_comparison: 2,
  comparison_includes_llm: true,
  automation_mode: "compare_humans",
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

async function loadRetry() {
  return (await import("@/actions/comparisons")).retryPendingComparisons;
}

describe("retryPendingComparisons — guards", () => {
  it("não-coordenador → erro, sem efeito", async () => {
    hoisted.isCoord.mockResolvedValueOnce(false);
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(false);
    expect(r.error).toContain("coordenadores");
    expect(writeCalls).toHaveLength(0);
  });

  it("modo não-comparação → no-op", async () => {
    tableData.projects = [projectRow({ automation_mode: "auto_review_llm" })];
    tableData.responses = [human("userA", "A"), human("userB", "B")];
    tableData.project_members = [{ user_id: "userC", project_id: "p1", can_compare: true }];
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(true);
    expect(r.assigned).toBe(0);
    expect(upsertCallsOf("assignments")).toHaveLength(0);
  });
});

describe("retryPendingComparisons — atribui backlog divergente", () => {
  it("doc divergente sem comparacao ativa → atribui 1", async () => {
    tableData.responses = [human("userA", "A"), human("userB", "B")];
    tableData.project_members = [{ user_id: "userC", project_id: "p1", can_compare: true }];
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(true);
    expect(r.assigned).toBe(1);
    expect(r.stillNoPool).toBe(0);
    expect(upsertCallsOf("assignments")[0].payload).toMatchObject({
      document_id: "doc1",
      user_id: "userC",
      type: "comparacao",
    });
  });

  it("doc divergente sem revisor elegível → stillNoPool", async () => {
    tableData.responses = [human("userA", "A"), human("userB", "B")];
    tableData.project_members = []; // ninguém can_compare
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(true);
    expect(r.assigned).toBe(0);
    expect(r.stillNoPool).toBe(1);
  });

  it("doc em consenso → nada a atribuir", async () => {
    tableData.responses = [human("userA", "A"), human("userB", "A")];
    tableData.project_members = [{ user_id: "userC", project_id: "p1", can_compare: true }];
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(true);
    expect(r.assigned).toBe(0);
  });
});
