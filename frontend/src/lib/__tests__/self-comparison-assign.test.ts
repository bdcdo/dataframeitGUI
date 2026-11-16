import { describe, expect, it, vi } from "vitest";
import {
  assignSelfComparisons,
  parseSelfComparisonArgs,
  formatSelfComparisonPlan,
  planSelfComparisons,
  runSelfComparisonCli,
  type SelfComparisonArgs,
} from "@/lib/self-comparison-assign";
import { makeFilterAwareSupabaseMock, type WriteCall } from "@/test-utils/supabase-mock";
import type { SupabaseServerClient } from "@/lib/supabase/server";
import { makeHumanResponse } from "@/test-utils/comparison-fixtures";

type Fixture = Omit<Parameters<typeof makeFilterAwareSupabaseMock>[0], "writeCalls">;
const mockClient = (fixture: Fixture, writeCalls: WriteCall[] = []) =>
  makeFilterAwareSupabaseMock({ ...fixture, writeCalls }) as unknown as SupabaseServerClient;
// As colunas que as queries de `assignSelfComparisons` filtram.
const document = (id: string, extra: Record<string, unknown> = {}) => ({
  id, project_id: "p1", excluded_at: null, exclusion_pending_at: null, ...extra,
});
const response = (document_id: string, extra: Record<string, unknown> = {}) =>
  makeHumanResponse("u1", "a", { document_id, ...extra });

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

describe("formatSelfComparisonPlan", () => {
  it("diz o que atribuiu (ou atribuiria) e por que pulou cada documento", () => {
    const plan = { assign: ["d1"], skipped: [{ documentId: "d2", reason: "não codificou" as const }] };
    expect(formatSelfComparisonPlan(plan, true)).toEqual([
      "atribuiria 1 autocomparação(ões), nada gravado",
      "  + d1",
      "  - d2: não codificou",
    ]);
    expect(formatSelfComparisonPlan(plan, false)[0]).toBe("atribuiu 1 autocomparação(ões)");
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
  const assignment = (
    document_id: string, user_id: string, type: string, status: string, extra: Record<string, unknown> = {},
  ) => ({
    document_id, user_id, type, status, project_id: "p1", round_id: "r1", ...extra,
  });
  // As linhas declaram as colunas que as queries filtram, e cada tabela traz
  // linhas que o filtro precisa descartar; o teste "cada documento fica de
  // fora..." diz o que cada documento exercita.
  const tables = (
    project: Record<string, unknown> = { automation_mode: "compare_llm", current_round_id: "r1" },
  ): Fixture => ({
    tableData: {
      projects: [{ id: "p1", ...project }, { id: "p2", automation_mode: "compare_llm", current_round_id: "r1" }],
      documents: [
        ...["d1", "d2", "d5", "d7", "d8", "d9"].map((id) => document(id)),
        document("d3", { excluded_at: "2026-01-01" }),
        document("d4", { project_id: "p2" }),
        document("d6", { exclusion_pending_at: "2026-01-01" }),
      ],
      responses: [
        ...["d1", "d2", "d3", "d4", "d6", "d7", "d8", "d9"].map((id) => response(id)),
        response("d5", { is_partial: true }),
        response("d5", { respondent_type: "llm" }),
        response("d5", { is_latest: false }),
        response("d5", { respondent_id: "outro" }),
        response("d5", { project_id: "p2" }),
      ],
      assignments: [
        assignment("d1", "u1", "codificacao", "concluido"),
        assignment("d1", "u1", "comparacao", "pendente", { round_id: "r0" }),
        assignment("d1", "outro", "comparacao", "pendente", { project_id: "p2" }),
        assignment("d2", "outro", "comparacao", "pendente"),
        assignment("d7", "u1", "codificacao", "em_andamento"),
        assignment("d8", "u1", "comparacao", "concluido"),
        assignment("d9", "outro", "codificacao", "pendente"),
        assignment("d9", "outro", "comparacao", "concluido"),
      ],
    },
  });
  const run = async (fixture: Fixture, a: SelfComparisonArgs, writeCalls: WriteCall[] = []) => {
    return { plan: await assignSelfComparisons(mockClient(fixture, writeCalls), a), writeCalls };
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
        filters: [],
      },
    ]);
  });

  it("cada documento fica de fora pela razão que a base e a rodada dão", async () => {
    const ids = ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9"];
    const { plan } = await run(tables(), args({ source: { kind: "documents", ids }, dryRun: true }));
    expect(plan).toEqual({
      assign: ["d1", "d9"],
      skipped: [
        { documentId: "d2", reason: "comparação ativa na rodada" },
        { documentId: "d3", reason: "documento fora da base" },
        { documentId: "d4", reason: "documento fora da base" },
        { documentId: "d5", reason: "não codificou" },
        { documentId: "d6", reason: "documento fora da base" },
        { documentId: "d7", reason: "codificação em aberto na rodada" },
        { documentId: "d8", reason: "já tem comparação nesta rodada" },
      ],
    });
  });

  it("--dry-run não grava", async () => {
    const { plan, writeCalls } = await run(tables(), args({ dryRun: true }));
    expect(plan.assign).toEqual(["d1"]);
    expect(writeCalls).toEqual([]);
  });

  it("--backlog só pega os documentos que o pesquisador codificou", async () => {
    backlog.entries = [
      { documentId: "d1", coderIds: new Set(["u1"]) },
      { documentId: "d9", coderIds: new Set(["outro"]) },
    ];
    const { plan } = await run(tables(), args({ source: { kind: "backlog" }, dryRun: true }));
    expect(plan).toEqual({ assign: ["d1"], skipped: [] });
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
    const fixture = tables();
    fixture.queryErrors = {
      "assignments:insert": { code: "23505", message: "duplicate key value violates unique constraint" },
    };
    const writeCalls: WriteCall[] = [];
    await expect(run(fixture, args(), writeCalls)).rejects.toThrow(/Nada foi gravado; rode de novo/);
    expect(writeCalls.map((w) => [w.table, w.op])).toEqual([["assignments", "insert"]]);
  });
});

describe("runSelfComparisonCli", () => {
  const capture = () => {
    const lines: string[] = [];
    return { lines, out: { log: (l: string) => lines.push(l), error: (l: string) => lines.push(`ERRO ${l}`), missingEnv: "sem env" } };
  };
  const client = (fixture: Fixture) => () => mockClient(fixture);

  it("uso inválido e ambiente sem credenciais saem com 2", async () => {
    const a = capture();
    expect(await runSelfComparisonCli(["--backlog"], client({ tableData: {} }), a.out)).toBe(2);
    expect(a.lines[0]).toMatch(/^ERRO uso:/);
    const b = capture();
    expect(await runSelfComparisonCli([...BASE, "--backlog"], () => null, b.out)).toBe(2);
    expect(b.lines).toEqual(["ERRO sem env"]);
  });

  it("imprime o plano com 0, e falha do banco sai com 1", async () => {
    const ok = capture();
    const fixture: Fixture = {
      tableData: {
        projects: [{ id: "p1", automation_mode: "compare_llm", current_round_id: "r1" }],
        documents: [document("d1")],
        responses: [response("d1")],
        assignments: [],
      },
    };
    expect(await runSelfComparisonCli([...BASE, "--documents", "d1", "--dry-run"], client(fixture), ok.out)).toBe(0);
    expect(ok.lines).toEqual(["atribuiria 1 autocomparação(ões), nada gravado", "  + d1"]);

    const fail = capture();
    const broken: Fixture = { tableData: {}, queryErrors: { "projects:select": { message: "boom" } } };
    expect(await runSelfComparisonCli([...BASE, "--documents", "d1"], client(broken), fail.out)).toBe(1);
    expect(fail.lines).toEqual(["ERRO projects: boom"]);
  });
});
