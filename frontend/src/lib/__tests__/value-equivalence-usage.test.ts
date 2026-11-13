import { describe, expect, it } from "vitest";
import type { ValueEquivalence } from "@/lib/equivalence";
import {
  documentsWhereClassesApply,
  equivalenceClasses,
} from "@/lib/value-equivalence-usage";

function equivalence(id: string, valueA: unknown, valueB: unknown): ValueEquivalence {
  return { id, field_name: "q", field_hash: "h", value_a: valueA, value_b: valueB, reviewer_id: null };
}

describe("equivalenceClasses", () => {
  it("agrupa as equivalências encadeadas numa classe, com um valor por chave", () => {
    const classes = equivalenceClasses([
      equivalence("e1", "Não informado", "NI"),
      equivalence("e2", "ni", "N/A"),
      equivalence("e3", "sim", "yes"),
    ]);
    expect(classes).toHaveLength(2);
    const [big, small] = classes;
    expect(big.equivalences.map((e) => e.id)).toEqual(["e1", "e2"]);
    // "NI" e "ni" são o mesmo valor normalizado: aparece uma vez só.
    expect(big.values).toEqual(["Não informado", "NI", "N/A"]);
    expect(small.values).toEqual(["sim", "yes"]);
  });

  it("sem equivalências, nenhuma classe", () => {
    expect(equivalenceClasses([])).toEqual([]);
  });
});

describe("documentsWhereClassesApply", () => {
  const equivalences = [equivalence("e1", "NI", "N/A"), equivalence("e2", "N/A", "não se aplica")];
  const classKey = equivalenceClasses(equivalences)[0].classKey;

  it("só documentos com dois valores DISTINTOS da classe, de respostas à versão atual", () => {
    const usage = documentsWhereClassesApply(equivalences, [
      // d1: funde NI com não se aplica, via N/A ausente.
      { document_id: "d1", value: "NI", answersCurrentQuestion: true },
      { document_id: "d1", value: "não se aplica", answersCurrentQuestion: true },
      // d2: todos dizem o mesmo (só a normalização difere): não depende da equivalência.
      { document_id: "d2", value: "NI", answersCurrentQuestion: true },
      { document_id: "d2", value: " ni ", answersCurrentQuestion: true },
      // d3: a outra ponta foi respondida a outra versão da pergunta.
      { document_id: "d3", value: "NI", answersCurrentQuestion: true },
      { document_id: "d3", value: "N/A", answersCurrentQuestion: false },
      // d4: valor fora da classe.
      { document_id: "d4", value: "NI", answersCurrentQuestion: true },
      { document_id: "d4", value: "outra", answersCurrentQuestion: true },
    ]);
    expect(usage.get(classKey)).toEqual(["d1"]);
    expect(usage.size).toBe(1);
  });
});

describe("equivalenceUsageByClass", () => {
  it("títulos dos documentos e a regra da versão pela resposta", async () => {
    const { equivalenceUsageByClass } = await import("@/lib/value-equivalence-usage");
    const eq = { ...equivalence("e1", "NI", "N/A"), field_hash: "h1" };
    const field = { id: "f", name: "q", type: "text", description: "", hash: "h1" } as never;
    const usage = equivalenceUsageByClass(
      [
        { document_id: "d1", value: "NI", answer_field_hashes: { q: "h1" }, documents: { title: "Nota 1", external_id: null } },
        { document_id: "d1", value: "N/A", answer_field_hashes: null, documents: { title: "Nota 1", external_id: null } },
        { document_id: "d2", value: "NI", answer_field_hashes: { q: "h0" }, documents: { title: null, external_id: "EXT-2" } },
        { document_id: "d2", value: "N/A", answer_field_hashes: { q: "h1" }, documents: { title: null, external_id: "EXT-2" } },
      ],
      [eq],
      field,
    );
    expect(Object.values(usage)).toEqual([[{ id: "d1", title: "Nota 1" }]]);
  });
});
