import { describe, expect, it, vi } from "vitest";
import {
  buildReviewQueueDocumentMap,
  loadReviewQueueRows,
} from "@/lib/review-queue";
import type { SupabaseServerClient } from "@/lib/supabase/server";
import { makeFilterAwareSupabaseMock } from "@/test-utils/supabase-mock";

function makeClient(documents: unknown[]): SupabaseServerClient {
  return makeFilterAwareSupabaseMock({
    tableData: { documents },
    writeCalls: [],
  }) as unknown as SupabaseServerClient;
}

describe("loadReviewQueueRows", () => {
  it("não consulta ciclos quando a fila está vazia", async () => {
    const loadFieldReviews = vi.fn(() =>
      Promise.resolve({ data: [{ id: "unexpected" }] }),
    );

    const result = await loadReviewQueueRows(
      makeClient([]),
      [],
      loadFieldReviews,
    );

    expect(result).toEqual({ documents: [], fieldReviews: [] });
    expect(loadFieldReviews).not.toHaveBeenCalled();
  });

  it("carrega somente os documentos ativos solicitados junto com os ciclos", async () => {
    const result = await loadReviewQueueRows(
      makeClient([
        {
          id: "active",
          title: "Ativo",
          external_id: "A-1",
          text: "texto",
          excluded_at: null,
          exclusion_pending_at: null,
        },
        {
          id: "excluded",
          title: "Excluído",
          external_id: "A-2",
          text: "texto",
          excluded_at: "2026-07-16T00:00:00Z",
          exclusion_pending_at: null,
        },
      ]),
      ["active", "excluded"],
      () => Promise.resolve({ data: [{ id: "review-1" }] }),
    );

    expect(result).toEqual({
      documents: [
        expect.objectContaining({ id: "active", title: "Ativo" }),
      ],
      fieldReviews: [{ id: "review-1" }],
    });
  });
});

describe("buildReviewQueueDocumentMap", () => {
  it("constrói o payload base com uma lista de campos independente por documento", () => {
    const map = buildReviewQueueDocumentMap<{ fieldName: string }>([
      { id: "d1", title: "Um", external_id: null, text: "texto 1" },
      { id: "d2", title: null, external_id: "EXT-2", text: "texto 2" },
    ]);

    map.get("d1")?.fields.push({ fieldName: "q1" });

    expect(map.get("d1")).toEqual({
      docId: "d1",
      title: "Um",
      externalId: null,
      text: "texto 1",
      fields: [{ fieldName: "q1" }],
    });
    expect(map.get("d2")?.fields).toEqual([]);
  });
});
