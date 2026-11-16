import { describe, expect, it } from "vitest";
import {
  breakDownPendingAutoReviews,
  fetchPendingAutoReviews,
} from "@/lib/auto-review-pending";
import { makeFilterAwareSupabaseMock } from "@/test-utils/supabase-mock";

// #681: o coordenador não via quantas auto-revisões estavam pendentes nem com
// quem.

function review(
  id: string,
  reviewer: string,
  documentId: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    project_id: "p1",
    document_id: documentId,
    self_reviewer_id: reviewer,
    superseded_at: null,
    self_verdict: null,
    "documents.excluded_at": null,
    "documents.exclusion_pending_at": null,
    ...extra,
  };
}

function fetchPending(
  fieldReviews: unknown[],
  queryErrors?: Record<string, { message: string } | null>,
) {
  const client = makeFilterAwareSupabaseMock({
    tableData: { field_reviews: fieldReviews },
    writeCalls: [],
    queryErrors,
  }) as never;
  return fetchPendingAutoReviews(client, "p1");
}

describe("fetchPendingAutoReviews", () => {
  it("conta campos e documentos pendentes, no projeto e por revisor", async () => {
    const { data } = await fetchPending([
      review("r1", "ana", "d1"),
      review("r2", "ana", "d1"),
      review("r3", "ana", "d2"),
      review("r4", "bia", "d3"),
    ]);
    expect(data).toEqual({
      fields: 4,
      documents: 3,
      byReviewer: new Map([
        ["ana", { fields: 3, documents: 2 }],
        ["bia", { fields: 1, documents: 1 }],
      ]),
    });
  });

  it("documento dividido entre dois revisores conta uma vez no projeto", async () => {
    const { data } = await fetchPending([
      review("r1", "ana", "d1"),
      review("r2", "bia", "d1"),
    ]);
    expect(data?.documents).toBe(1);
    expect(data?.byReviewer.get("ana")).toEqual({ fields: 1, documents: 1 });
    expect(data?.byReviewer.get("bia")).toEqual({ fields: 1, documents: 1 });
  });

  it("deixa de fora o que a fila do revisor também não mostra", async () => {
    const { data } = await fetchPending([
      review("r1", "ana", "d1"),
      review("r2", "ana", "d2", { self_verdict: "concorda_llm" }),
      review("r3", "ana", "d3", { superseded_at: "2026-11-01T00:00:00Z" }),
      review("r4", "ana", "d4", {
        "documents.excluded_at": "2026-11-01T00:00:00Z",
      }),
      review("r5", "ana", "d5", {
        "documents.exclusion_pending_at": "2026-11-01T00:00:00Z",
      }),
      review("r6", "ana", "d6", { project_id: "p2" }),
    ]);
    expect(data).toEqual({
      fields: 1,
      documents: 1,
      byReviewer: new Map([["ana", { fields: 1, documents: 1 }]]),
    });
  });

  it("passa do teto de 1000 linhas do PostgREST", async () => {
    const rows = Array.from({ length: 1200 }, (_, i) =>
      review(
        `r${String(i).padStart(4, "0")}`,
        i < 700 ? "ana" : "bia",
        `d${i}`,
      ),
    );
    const { data } = await fetchPending(rows);
    expect(data?.fields).toBe(1200);
    expect(data?.byReviewer.get("ana")?.fields).toBe(700);
    expect(data?.byReviewer.get("bia")?.fields).toBe(500);
  });

  it("devolve o erro da leitura em vez de zero", async () => {
    const result = await fetchPending([review("r1", "ana", "d1")], {
      "field_reviews:select": { message: "boom" },
    });
    expect(result).toEqual({ data: null, error: { message: "boom" } });
  });
});

describe("breakDownPendingAutoReviews", () => {
  const load = (fields: number) => ({ fields, documents: 1 });
  const pending = {
    fields: 6,
    documents: 3,
    byReviewer: new Map([
      ["ana", load(1)],
      ["bia", load(3)],
      ["caio", load(2)],
    ]),
  };
  const member = (userId: string) => ({ user_id: userId });

  it("ordena os membros do mais carregado para o menos", () => {
    expect(
      breakDownPendingAutoReviews(
        pending,
        ["ana", "bia", "caio", "dora"].map(member),
      ),
    ).toEqual({
      reviewers: [
        { member: member("bia"), load: load(3) },
        { member: member("caio"), load: load(2) },
        { member: member("ana"), load: load(1) },
      ],
      outsideMemberList: 0,
    });
  });

  it("separa a pendência de quem não está na lista de membros", () => {
    expect(breakDownPendingAutoReviews(pending, [member("ana")])).toEqual({
      reviewers: [{ member: member("ana"), load: load(1) }],
      outsideMemberList: 5,
    });
  });
});
