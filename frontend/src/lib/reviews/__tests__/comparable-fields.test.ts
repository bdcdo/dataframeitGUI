import { describe, it, expect, vi } from "vitest";
import { fetchReviewBaseData } from "@/lib/reviews/queries";
import { computeDivergentFieldNames } from "@/lib/compare-divergence";
import { isMeasurableField } from "@/lib/llm-error-metrics";
import type { PydanticField } from "@/lib/types";
import { makeSupabaseMock } from "@/actions/__tests__/supabase-mock";

// Troca o default de `target` para `human_only`: se algum consumidor da
// Comparacao ainda re-derivar "ausente = all" no call site, o campo legado
// continua nele. Prova a regra (c2) do CLAUDE.md (issue #500).
vi.mock("@/lib/pydantic-field", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pydantic-field")>();
  return {
    ...actual,
    resolveTarget: (value: Parameters<typeof actual.resolveTarget>[0]) => value ?? "human_only",
  };
});

const legacy = { name: "legado", type: "text", options: null, description: "" } as PydanticField;
const all = { ...legacy, name: "todos", target: "all" } as PydanticField;

describe("o default de `target` da Comparação vem de `resolveTarget` (issue #500)", () => {
  it("gabarito, fila de divergência e métricas do LLM seguem o resolvedor", async () => {
    const client = makeSupabaseMock({
      tableResults: {
        projects: { data: { pydantic_fields: [legacy, all], pydantic_hash: null, created_by: "owner" } },
        responses: { data: [] },
        reviews: { data: [] },
        documents: { data: [] },
        profiles: { data: [] },
      },
      rpcResults: { read_error_resolutions: { data: [] } },
    });
    const ctx = await fetchReviewBaseData(client as never, "p1");
    expect(ctx.comparableFields.map((f) => f.name)).toEqual(["todos"]);

    const divergent = computeDivergentFieldNames([legacy, all], [
      { id: "1", answers: { legado: "a", todos: "a" } },
      { id: "2", answers: { legado: "b", todos: "b" } },
    ]);
    expect(divergent).toEqual(["todos"]);

    expect(isMeasurableField(legacy)).toBe(false);
  });
});
