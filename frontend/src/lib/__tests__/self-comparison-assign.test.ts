import { describe, expect, it, vi } from "vitest";
import {
  assignSelfComparisons,
  parseSelfComparisonArgs,
  planSelfComparisons,
  type SelfComparisonArgs,
} from "@/lib/self-comparison-assign";
import { makeSupabaseMock, type TableResults, type WriteCall } from "@/actions/__tests__/supabase-mock";
import type { SupabaseServerClient } from "@/lib/supabase/server";

const BASE = ["--project", "p1", "--user", "u1", "--approved-by", "c1"];

describe("parseSelfComparisonArgs", () => {
  it("aceita --backlog ou --documents, nunca os dois nem nenhum", () => {
    expect(parseSelfComparisonArgs([...BASE, "--backlog"])).toEqual({
      projectId: "p1", userId: "u1", approverId: "c1", source: { kind: "backlog" }, dryRun: false,
    });
    expect(parseSelfComparisonArgs([...BASE, "--documents", "d1, d2,", "--dry-run"])).toEqual({
      projectId: "p1", userId: "u1", approverId: "c1", source: { kind: "documents", ids: ["d1", "d2"] }, dryRun: true,
    });
    expect(parseSelfComparisonArgs([...BASE])).toBeNull();
    expect(parseSelfComparisonArgs([...BASE, "--backlog", "--documents", "d1"])).toBeNull();
  });

  it("recusa argumento desconhecido, valor faltando e flag obrigatória ausente", () => {
    expect(parseSelfComparisonArgs([...BASE, "--backlog", "--dryrun"])).toBeNull();
    expect(parseSelfComparisonArgs(["--project", "--user", "u1", "--approved-by", "c1", "--backlog"])).toBeNull();
    expect(parseSelfComparisonArgs(["--project", "p1", "--user", "u1", "--backlog"])).toBeNull();
    expect(parseSelfComparisonArgs([...BASE, "--documents", ","])).toBeNull();
  });
});

describe("planSelfComparisons", () => {
  it("recusa cada caso pela primeira razão que se aplica", () => {
    expect(
      planSelfComparisons({
        documentIds: ["ok", "arquivado", "alheio", "aberto", "ativo", "feito", "ok"],
        inBase: new Set(["ok", "alheio", "aberto", "ativo", "feito"]),
        codedByUser: new Set(["ok", "arquivado", "aberto", "ativo", "feito"]),
        openCodingThisRound: new Set(["aberto"]),
        activeComparisonThisRound: new Set(["ativo"]),
        userComparisonThisRound: new Set(["feito"]),
      }),
    ).toEqual({
      assign: ["ok"],
      skipped: [
        { documentId: "arquivado", reason: "documento fora da base" },
        { documentId: "alheio", reason: "não codificou" },
        { documentId: "aberto", reason: "codificação em aberto na rodada" },
        { documentId: "ativo", reason: "comparação ativa na rodada" },
        { documentId: "feito", reason: "já tem comparação nesta rodada" },
      ],
    });
  });
});

const backlog = vi.hoisted(() => ({ entries: [] as { documentId: string; coderIds: Set<string> }[] }));
vi.mock("@/lib/auto-comparison", () => ({
  scanComparisonBacklog: async () => backlog.entries,
}));

describe("assignSelfComparisons", () => {
  const args = (overrides: Partial<SelfComparisonArgs> = {}): SelfComparisonArgs => ({
    projectId: "p1", userId: "u1", approverId: "c1",
    source: { kind: "documents", ids: ["d1", "d2"] }, dryRun: false, ...overrides,
  });
  const tables = (project: unknown = { automation_mode: "compare_llm", current_round_id: "r1" }): TableResults => ({
    projects: { data: project },
    documents: { data: [{ id: "d1" }, { id: "d2" }] },
    responses: { data: [{ document_id: "d1" }, { document_id: "d2" }] },
    assignments: [
      { data: [{ document_id: "d2", user_id: "outro", type: "comparacao", status: "pendente" }] },
      { data: null },
    ],
  });
  const run = async (results: TableResults, a: SelfComparisonArgs) => {
    const writeCalls: WriteCall[] = [];
    const client = makeSupabaseMock({ tableResults: results, writeCalls }) as unknown as SupabaseServerClient;
    return { plan: await assignSelfComparisons(client, a), writeCalls };
  };

  it("grava num único INSERT, com a liberação do coordenador", async () => {
    const { plan, writeCalls } = await run(tables(), args());

    expect(plan.assign).toEqual(["d1"]);
    expect(writeCalls).toEqual([
      {
        table: "assignments",
        op: "insert",
        payload: [{
          project_id: "p1", document_id: "d1", user_id: "u1",
          type: "comparacao", status: "pendente", self_comparison_approved_by: "c1",
        }],
      },
    ]);
  });

  it("--dry-run não grava", async () => {
    const { plan, writeCalls } = await run(tables(), args({ dryRun: true }));
    expect(plan.assign).toEqual(["d1"]);
    expect(writeCalls).toEqual([]);
  });

  it("--backlog só pega os documentos que o pesquisador codificou", async () => {
    backlog.entries = [
      { documentId: "d1", coderIds: new Set(["u1"]) },
      { documentId: "d3", coderIds: new Set(["outro"]) },
    ];
    const { plan } = await run(tables(), args({ source: { kind: "backlog" }, dryRun: true }));
    expect(plan.assign).toEqual(["d1"]);
  });

  it("--backlog recusa projeto fora dos modos de comparação, e projeto sem rodada é erro claro", async () => {
    await expect(
      run(tables({ automation_mode: "auto_review_llm", current_round_id: "r1" }), args({ source: { kind: "backlog" } })),
    ).rejects.toThrow(/sem backlog de comparação/);
    await expect(run(tables({ automation_mode: "compare_llm", current_round_id: null }), args())).rejects.toThrow(
      /não possui uma rodada atual/,
    );
  });

  it("conflito na gravação vira mensagem legível, sem gravação parcial", async () => {
    const results = tables();
    results.assignments = [
      { data: [] },
      { error: { code: "23505", message: "duplicate key value violates unique constraint" } },
    ];
    await expect(run(results, args())).rejects.toThrow(/Nada foi gravado; rode de novo/);
  });
});
