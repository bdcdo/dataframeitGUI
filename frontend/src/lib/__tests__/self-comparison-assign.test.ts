import { describe, expect, it } from "vitest";
import {
  assignSelfComparisons,
  parseSelfComparisonArgs,
  planSelfComparisons,
} from "@/lib/self-comparison-assign";
import { makeSupabaseMock, type WriteCall } from "@/actions/__tests__/supabase-mock";
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
  it("atribui só o que o pesquisador codificou, sem comparação ativa nem dele na rodada", () => {
    expect(
      planSelfComparisons({
        documentIds: ["ok", "alheio", "ativo", "feito", "ok"],
        codedByUser: new Set(["ok", "ativo", "feito"]),
        activeComparison: new Set(["ativo"]),
        userComparisonThisRound: new Set(["feito"]),
      }),
    ).toEqual({
      assign: ["ok"],
      skipped: [
        { documentId: "alheio", reason: "não codificou" },
        { documentId: "ativo", reason: "comparação ativa" },
        { documentId: "feito", reason: "já tem comparação nesta rodada" },
      ],
    });
  });
});

describe("assignSelfComparisons", () => {
  const tables = () => ({
    projects: { data: { current_round_id: "r1" } },
    responses: { data: [{ document_id: "d1" }, { document_id: "d2" }] },
    assignments: [
      { data: [{ document_id: "d2", user_id: "outro", status: "pendente", round_id: "r1" }] },
      { data: null },
    ],
  });

  it("grava num único INSERT, com a liberação do coordenador", async () => {
    const writeCalls: WriteCall[] = [];
    const client = makeSupabaseMock({ tableResults: tables(), writeCalls }) as unknown as SupabaseServerClient;

    const plan = await assignSelfComparisons(client, {
      projectId: "p1", userId: "u1", approverId: "c1",
      source: { kind: "documents", ids: ["d1", "d2"] }, dryRun: false,
    });

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
    const writeCalls: WriteCall[] = [];
    const client = makeSupabaseMock({ tableResults: tables(), writeCalls }) as unknown as SupabaseServerClient;

    const plan = await assignSelfComparisons(client, {
      projectId: "p1", userId: "u1", approverId: "c1",
      source: { kind: "documents", ids: ["d1"] }, dryRun: true,
    });

    expect(plan.assign).toEqual(["d1"]);
    expect(writeCalls).toEqual([]);
  });
});
