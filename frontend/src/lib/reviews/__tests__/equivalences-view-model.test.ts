import { describe, expect, it } from "vitest";
import {
  buildEquivalenceFieldViews,
  buildEquivalenceHistoryViews,
  type EquivalenceRowWithMeta,
} from "@/lib/reviews/equivalences-view-model";
import type { PydanticField } from "@/lib/types";

const FIELDS = [
  { id: "f1", name: "q1", type: "text", description: "Data de nascimento", hash: "h1" },
  { id: "f2", name: "q2", type: "text", description: "", hash: "h2" },
  { id: "f3", name: "q3", type: "text", description: "Sem equivalência", hash: "h3" },
] as unknown as PydanticField[];

function row(id: string, field: string, hash: string, a: unknown, b: unknown, reviewer: string | null): EquivalenceRowWithMeta {
  return {
    id, field_name: field, field_hash: hash, value_a: a, value_b: b, reviewer_id: reviewer,
    source: "comparacao", created_at: "2026-11-01T12:00:00Z",
  };
}

const NAMES = new Map([["u1", "ana"], ["u2", "bia"]]);

describe("buildEquivalenceFieldViews", () => {
  const rows = [
    row("e1", "q1", "h1", "Não informada", "XX/XX/XXXX", "u1"),
    row("e2", "q1", "h1", "XX/XX/XXXX", "NI", "u2"),
    row("e3", "q2", "h2", null, "Não se aplica", null),
    // Outra versão da pergunta: não aparece entre as vigentes.
    row("e4", "q1", "h0", "a", "b", "u1"),
  ];

  it("por campo, na ordem do schema, só a versão atual, com classes encadeadas", () => {
    const views = buildEquivalenceFieldViews(FIELDS, rows, NAMES, { isCoordinator: false, memberUserId: "u1" });
    expect(views.map((v) => [v.name, v.label])).toEqual([["q1", "Data de nascimento"], ["q2", "q2"]]);
    expect(views[0].classes).toHaveLength(1);
    // Data parcial sai como nos cards da Comparação (`formatCardAnswer`).
    expect(views[0].classes[0].values).toEqual(["Não informada", "—/—/—", "NI"]);
    expect(views[0].classes[0].equivalences.map((e) => [e.id, e.reviewerName, e.sourceLabel, e.canUndo])).toEqual([
      ["e1", "ana", "Comparação", true],
      ["e2", "bia", "Comparação", false],
    ]);
    // Valor vazio aparece como "(vazio)"; sem dono, "—".
    expect(views[1].classes[0].equivalences[0]).toMatchObject({ display: "(vazio) = Não se aplica", reviewerName: "—", canUndo: false });
  });

  it("coordenação desfaz qualquer uma", () => {
    const views = buildEquivalenceFieldViews(FIELDS, rows, NAMES, { isCoordinator: true, memberUserId: null });
    expect(views.flatMap((v) => v.classes.flatMap((c) => c.equivalences.map((e) => e.canUndo)))).toEqual([true, true, true]);
  });
});

describe("buildEquivalenceHistoryViews", () => {
  it("rótulo do campo e do motivo; campo fora do schema mostra o nome", () => {
    const views = buildEquivalenceHistoryViews(FIELDS, [
      { id: "h1", field_name: "q1", value_a: "a", value_b: "b", reviewer_id: "u1", superseded_at: "2026-11-02T00:00:00Z", superseded_reason: "question_changed" },
      { id: "h2", field_name: "velho", value_a: "c", value_b: "d", reviewer_id: null, superseded_at: "2026-11-03T00:00:00Z", superseded_reason: "field_removed" },
    ], NAMES);
    expect(views.map((v) => [v.fieldLabel, v.display, v.reasonLabel, v.reviewerName])).toEqual([
      ["Data de nascimento", "a = b", "Pergunta alterada", "ana"],
      ["velho", "c = d", "Campo removido ou renomeado", "—"],
    ]);
  });
});
