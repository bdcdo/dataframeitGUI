import { describe, it, expect, vi } from "vitest";
import { fetchReviewBaseData } from "@/lib/reviews/queries";
import { computeDivergentFieldNames } from "@/lib/compare-divergence";
import { isMeasurableField } from "@/lib/llm-error-metrics";
import { assembleExport, type ExportResponse } from "@/lib/export/assemble";
import type { PydanticField } from "@/lib/types";
import { makeFilterAwareSupabaseMock } from "@/test-utils/supabase-mock";

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
    const client = makeFilterAwareSupabaseMock({
      tableData: {
        projects: [{ id: "p1", pydantic_fields: [legacy, all], pydantic_hash: null, created_by: "owner" }],
        responses: [],
        reviews: [],
        documents: [],
        profiles: [],
      },
      writeCalls: [],
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

// O motivo de Pendência do export dizia "divergência entre pesquisadores" (a
// Comparação resolveria) para todo campo que não fosse `human_only`, re-derivando
// o default no call site, enquanto a fila não enfileirava o mesmo campo.
describe("o export classifica a divergência pela mesma regra da fila", () => {
  it("campo fora da Comparação vira \"não entra na Comparação\", e não \"divergência entre pesquisadores\"", () => {
    const resp = (id: string, value: string): ExportResponse => ({
      id,
      document_id: "d1",
      respondent_type: "humano",
      respondent_name: id,
      answers: { legado: value },
      is_partial: false,
    });
    const { pending } = assembleExport({
      projectName: "P",
      fields: [legacy],
      minResponses: 2,
      documents: [{ id: "d1", external_id: "A", title: null, created_at: "2024-01-01T00:00:00Z", metadata: null }],
      responses: [resp("h1", "Sim"), resp("h2", "Não")],
      reviews: [],
    });
    expect(pending.rows.map((row) => row.at(-1))).toEqual([
      "respostas divergem e o campo não entra na Comparação",
    ]);
  });
});
