import { describe, expect, it, vi } from "vitest";
import {
  buildReviewQueueDocumentMap,
  loadReviewQueueRows,
} from "@/lib/review-queue";
import { fetchAllAfterId } from "@/lib/supabase/fetch-all-paged";
import type { SupabaseServerClient } from "@/lib/supabase/server";
import {
  makeFilterAwareSupabaseMock,
  type ReadCall,
} from "@/test-utils/supabase-mock";

type QueryErrorForCall = NonNullable<
  Parameters<typeof makeFilterAwareSupabaseMock>[0]["queryErrorForCall"]
>;

function makeClient(documents: unknown[]): SupabaseServerClient {
  return makeFilterAwareSupabaseMock({
    tableData: { documents },
    writeCalls: [],
  }) as unknown as SupabaseServerClient;
}

describe("loadReviewQueueRows", () => {
  it("não consulta ciclos quando a fila está vazia", async () => {
    const loadFieldReviews = vi.fn(() =>
      Promise.resolve({ data: [{ id: "unexpected" }], error: null }),
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
      () => Promise.resolve({ data: [{ id: "review-1" }], error: null }),
    );

    expect(result).toEqual({
      documents: [
        expect.objectContaining({ id: "active", title: "Ativo" }),
      ],
      fieldReviews: [{ id: "review-1" }],
    });
  });

  // A lista inteira num `.in()` só vai na URL do PostgREST: com fila grande a
  // requisição estoura, e a fila abria vazia.
  describe("fila grande", () => {
    const ids = Array.from(
      { length: 250 },
      (_, i) => `doc-${String(i).padStart(3, "0")}`,
    );
    const tableData = {
      documents: ids.map((id) => ({
        id,
        title: id,
        external_id: null,
        text: "texto",
        excluded_at: null,
        exclusion_pending_at: null,
      })),
      field_reviews: ids.map((id) => ({ id: `review-${id}`, document_id: id })),
    };

    function load(queryErrorForCall?: QueryErrorForCall) {
      const readCalls: ReadCall[] = [];
      const client = makeFilterAwareSupabaseMock({
        tableData,
        writeCalls: [],
        readCalls,
        queryErrorForCall,
      }) as unknown as SupabaseServerClient;
      const result = loadReviewQueueRows(client, ids, (chunk) =>
        fetchAllAfterId<{ id: string; document_id: string }>(() =>
          client
            .from("field_reviews")
            .select("id, document_id")
            .in("document_id", chunk),
        ),
      );
      return { result, readCalls };
    }

    it("lê documentos e ciclos em lotes de até 100 ids, sem perder nenhum", async () => {
      const { result, readCalls } = load();
      const { documents, fieldReviews } = await result;

      expect(documents.map((document) => document.id)).toEqual(ids);
      expect(fieldReviews.map((review) => review.document_id)).toEqual(ids);
      const inSizes = (table: string) =>
        readCalls
          .filter((call) => call.table === table)
          .map(
            (call) =>
              (call.filters.find(([kind]) => kind === "in")?.[2] as string[])
                .length,
          );
      expect(inSizes("documents")).toEqual([100, 100, 50]);
      expect(inSizes("field_reviews")).toEqual([100, 100, 50]);
    });

    it.each(["documents", "field_reviews"])(
      "lote de %s que falha lança em vez de abrir a fila sem ele",
      async (table) => {
        const { result } = load((call) =>
          call.table === table &&
          call.filters.some(
            ([kind, , value]) =>
              kind === "in" && (value as string[]).includes("doc-150"),
          )
            ? { message: "timeout" }
            : undefined,
        );

        await expect(result).rejects.toThrow(
          "Não foi possível carregar a fila de revisão: timeout",
        );
      },
    );
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
