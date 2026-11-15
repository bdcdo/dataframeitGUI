import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ValueEquivalence } from "@/lib/equivalence";
import {
  computeLlmErrorMetrics,
  type MetricsResponse,
  type MetricsReview,
} from "@/lib/llm-error-metrics";
import { errorQueueTab, type ErrorResolutionRow } from "@/lib/error-resolution";
import type { PydanticField } from "@/lib/types";

// Segunda metade do ciclo da fila do LLM Insights (#745). A primeira é a suíte
// SQL abaixo: ela grava as ações do card pelas RPCs e confere que o banco
// devolve exatamente o "expected" do fixture. Este teste lê o MESMO bloco
// daquele arquivo e classifica essa saída como a página faz. Assim a linha
// classificada é a do banco, e não uma montada à mão (como no teste de
// propriedade de llm-error-metrics.test.ts).
const SQL_SUITE = new URL(
  "../../../supabase/tests/error_resolution_cycle.test.sql",
  import.meta.url,
);

interface Cell {
  document_id: string;
  llm_response_id: string;
  human_response_id: string;
  review_id: string;
  action: string;
  llm_answer: string;
  human_answer: string;
}
interface CycleFixture {
  input: {
    project_id: string;
    fields: PydanticField[];
    cells: Cell[];
  };
  expected: {
    read_error_resolutions: Array<Omit<ErrorResolutionRow, "current_context"> & { current_context: string }>;
    value_equivalences: ValueEquivalence[];
  };
}

function loadFixture(): CycleFixture {
  const sql = readFileSync(SQL_SUITE, "utf8");
  const block = /\$fixture\$([\s\S]*?)\$fixture\$/.exec(sql);
  if (!block) throw new Error("bloco $fixture$ ausente da suíte SQL");
  return JSON.parse(block[1]) as CycleFixture;
}

const fixture = loadFixture();
const { input, expected } = fixture;

// O contexto corrente é igual ao gravado: a suíte SQL confere isso cru, antes
// de normalizar, e o fixture o registra como marcador.
const resolutions: ErrorResolutionRow[] = expected.read_error_resolutions.map((row) => {
  expect(row.current_context).toBe("<igual a context>");
  return { ...row, current_context: structuredClone(row.context) };
});

function response(overrides: Partial<MetricsResponse>): MetricsResponse {
  return {
    id: "",
    document_id: "",
    respondent_type: "humano",
    is_latest: true,
    answers: {},
    justifications: null,
    answer_field_hashes: null,
    created_at: "2026-11-01T00:00:00Z",
    schema_version_major: 1,
    schema_version_minor: 0,
    schema_version_patch: 0,
    ...overrides,
  };
}

const field = input.fields[0];
const metrics = computeLlmErrorMetrics({
  fields: input.fields,
  automationMode: "compare_llm",
  documentTitles: new Map(input.cells.map((c) => [c.document_id, "Documento"])),
  responses: input.cells.flatMap((c) => [
    response({ id: c.llm_response_id, document_id: c.document_id, respondent_type: "llm",
      answers: { [field.name]: c.llm_answer } }),
    response({ id: c.human_response_id, document_id: c.document_id,
      answers: { [field.name]: c.human_answer } }),
  ]),
  // O veredito como a suíte o grava; o field_hash é o que o trigger carimba.
  reviews: input.cells.map((c): MetricsReview => ({
    id: c.review_id, document_id: c.document_id, field_name: field.name,
    verdict: c.human_answer, chosen_response_id: c.human_response_id, comment: null,
    created_at: "2026-11-02T00:00:00Z", field_hash: field.hash ?? null,
  })),
  finalAnswers: [],
  equivalences: expected.value_equivalences,
  errorResolutions: new Map(resolutions.map((r) => [`${r.document_id}:${r.field_name}`, r])),
});

function classify(documentId: string) {
  const card = metrics.errors.find((e) => e.documentId === documentId && e.fieldName === field.name);
  const entry = metrics.reviewedEntries.find((e) => e.documentId === documentId && e.fieldName === field.name);
  return {
    tab: card ? errorQueueTab(card.resolution) : null,
    measuredError: entry?.isError ?? null,
    pending: entry?.isPending ?? false,
  };
}

// O que cada ação promete na carga seguinte (a mesma tabela do teste de
// propriedade do #893): a decisão tira o card dos abertos, "Em discussão" o
// leva para a aba de discussão, e o "=" o tira da fila.
const promised: Record<string, ReturnType<typeof classify>> = {
  llm_correct: { tab: "resolved", measuredError: false, pending: false },
  researchers_correct: { tab: "resolved", measuredError: true, pending: false },
  both_correct: { tab: "resolved", measuredError: false, pending: false },
  all_wrong: { tab: "resolved", measuredError: true, pending: false },
  discussion: { tab: "discussion", measuredError: true, pending: true },
  equivalent: { tab: null, measuredError: false, pending: false },
};

describe("ciclo da fila do LLM Insights com a saída do banco (#745)", () => {
  it("o fixture cobre as cinco decisões e o \"=\", uma célula cada", () => {
    expect(input.cells.map((c) => c.action).toSorted()).toEqual(Object.keys(promised).toSorted());
    expect(resolutions).toHaveLength(5);
    expect(expected.value_equivalences).toHaveLength(1);
  });

  it.each(input.cells.map((c) => [c.action, c.document_id] as const))(
    "%s: a linha lida do banco classifica o card como a ação prometeu",
    (action, documentId) => {
      expect(classify(documentId)).toEqual(promised[action]);
    },
  );
});
