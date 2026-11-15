import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchReviewBaseData } from "@/lib/reviews/queries";
import { computeDivergentFieldNames } from "@/lib/compare-divergence";
import type { PydanticField } from "@/lib/types";
import type { PydanticFieldTarget } from "@/lib/pydantic-field";
import { makeSupabaseMock } from "@/actions/__tests__/supabase-mock";

// Permite trocar o default de `target` sem mexer no modulo real: e assim que se
// prova que a Comparacao le o default do resolvedor e nao de uma copia no call
// site (regra (c2) do CLAUDE.md, issue #500).
const targetDefault = vi.hoisted(() => ({
  value: null as PydanticFieldTarget | null,
}));

vi.mock("@/lib/pydantic-field", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pydantic-field")>();
  return {
    ...actual,
    resolveTarget: (value: PydanticFieldTarget | null | undefined) =>
      targetDefault.value !== null && value == null
        ? targetDefault.value
        : actual.resolveTarget(value),
  };
});

afterEach(() => {
  targetDefault.value = null;
});

const field = (name: string, target?: PydanticFieldTarget): PydanticField =>
  ({ name, type: "text", options: null, description: name, ...(target ? { target } : {}) }) as PydanticField;

async function comparableNames(fields: PydanticField[]): Promise<string[]> {
  const client = makeSupabaseMock({
    tableResults: {
      projects: { data: { pydantic_fields: fields, pydantic_hash: null, created_by: "owner" } },
      responses: { data: [] },
      reviews: { data: [] },
      documents: { data: [] },
      profiles: { data: [] },
    },
    rpcResults: { read_error_resolutions: { data: [] } },
  });
  const ctx = await fetchReviewBaseData(client as never, "p1");
  return ctx.comparableFields.map((f) => f.name);
}

// Os dois lados da Comparacao (gabarito e fila de divergencia) decidem o mesmo
// conjunto de campos; com o default trocado, nenhum dos dois pode ficar com a
// copia antiga da regra.
const divergentNames = (fields: PydanticField[]) =>
  computeDivergentFieldNames(fields, [
    { id: "1", answers: Object.fromEntries(fields.map((f) => [f.name, "a"])) },
    { id: "2", answers: Object.fromEntries(fields.map((f) => [f.name, "b"])) },
  ]);

describe("comparableFields e computeDivergentFieldNames (issue #500)", () => {
  it("campo legado sem `target` continua comparável; só `all` entra", async () => {
    expect(
      await comparableNames([
        field("legado"),
        field("todos", "all"),
        field("so_llm", "llm_only"),
        field("so_humano", "human_only"),
        field("nenhum", "none"),
      ]),
    ).toEqual(["legado", "todos"]);
  });

  it("o default de `target` vem de `resolveTarget`, não do call site", async () => {
    const fields = [field("legado"), field("todos", "all")];
    expect(divergentNames(fields)).toEqual(["legado", "todos"]);

    targetDefault.value = "human_only";
    expect(await comparableNames(fields)).toEqual(["todos"]);
    expect(divergentNames(fields)).toEqual(["todos"]);
  });
});
