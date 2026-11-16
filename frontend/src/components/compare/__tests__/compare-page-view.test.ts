// Derivações puras extraídas de `ComparePage` (#564). A suíte do componente
// cobre o mesmo comportamento pela árvore montada; aqui cada ramo fica fixado
// por tabela.
import { describe, it, expect } from "vitest";
import type { DocCoverage } from "@/lib/compare-queue";
import type { VerdictInfo } from "@/lib/compare-reviews";
import {
  buildDocListEntries,
  docTitleOf,
  fieldCommentCountOf,
  fieldPanelPropsOf,
  resolveEmptyMessage,
  type EmptyQueueContext,
} from "../compare-page-view";
import { doc } from "./compare-test-helpers";

function coverage(docId: string, over: Partial<DocCoverage> = {}): DocCoverage {
  return {
    docId,
    humanCount: 2,
    totalCount: 3,
    assignedCodingCount: 2,
    humansFromAssigned: 1,
    divergentCount: 4,
    reviewedCount: 1,
    assignmentStatus: "em_andamento",
    ...over,
  };
}

function verdict(value: string): VerdictInfo {
  return { verdict: value, chosenResponseId: null, comment: null };
}

describe("buildDocListEntries", () => {
  it("copia a cobertura do servidor quando não há veredito local", () => {
    const [entry] = buildDocListEntries(
      [doc("d1", "Doc 1")],
      { d1: coverage("d1") },
      { d1: ["a", "b"] },
      {},
    );
    expect(entry).toEqual({
      id: "d1",
      title: "Doc 1",
      external_id: null,
      humanCount: 2,
      totalCount: 3,
      assignedCodingCount: 2,
      humansFromAssigned: 1,
      divergentCount: 4,
      reviewedCount: 1,
      assignmentStatus: "em_andamento",
    });
  });

  it("com veredito local, conta os divergentes revisados nesta sessão", () => {
    const [entry] = buildDocListEntries(
      [doc("d1")],
      { d1: coverage("d1", { reviewedCount: 0 }) },
      { d1: ["a", "b", "c"] },
      // `x` revisado mas fora dos divergentes não conta.
      { d1: { a: verdict("sim"), c: verdict("não"), x: verdict("sim") } },
    );
    expect(entry.reviewedCount).toBe(2);
  });

  it("documento sem cobertura aparece zerado, e não some", () => {
    const entries = buildDocListEntries([doc("d1"), doc("d2")], {}, {}, {});
    expect(entries.map((e) => e.id)).toEqual(["d1", "d2"]);
    expect(entries[0]).toMatchObject({
      humanCount: 0,
      totalCount: 0,
      assignedCodingCount: 0,
      humansFromAssigned: 0,
      divergentCount: 0,
      reviewedCount: 0,
      assignmentStatus: null,
    });
  });

  it("veredito local sem lista de divergentes conta zero", () => {
    const [entry] = buildDocListEntries(
      [doc("d1")],
      { d1: coverage("d1", { reviewedCount: 5 }) },
      {},
      { d1: { a: verdict("sim") } },
    );
    expect(entry.reviewedCount).toBe(0);
  });
});

describe("resolveEmptyMessage", () => {
  const base: EmptyQueueContext = {
    hasDocuments: false,
    isCoordinator: true,
    showingAll: false,
    hasAssignedDocs: false,
    isImpersonating: false,
  };

  it.each<[string, Partial<EmptyQueueContext>, string]>([
    ["doc sem divergência", { hasDocuments: true }, "Nenhuma divergência neste documento."],
    ["coordenador sem atribuídos", {}, "Você não tem documentos atribuídos"],
    ["coordenador com atribuídos filtrados", { hasAssignedDocs: true }, "Seus documentos atribuídos não atendem"],
    ["impersonando sem atribuídos", { isImpersonating: true }, "Este membro não tem documentos atribuídos"],
    [
      "impersonando com atribuídos filtrados",
      { isImpersonating: true, hasAssignedDocs: true },
      "Os documentos atribuídos a este membro não atendem",
    ],
    ["aba Todos", { showingAll: true }, "Nenhum documento na fila com os filtros atuais."],
    ["pesquisador", { isCoordinator: false, hasAssignedDocs: true }, "Nenhum documento na fila com os filtros atuais."],
  ])("%s", (_name, over, expected) => {
    expect(resolveEmptyMessage({ ...base, ...over })).toContain(expected);
  });
});

describe("fieldCommentCountOf", () => {
  it("soma os comentários do campo e os do documento inteiro", () => {
    const counts = { "d1|q1": 2, "d1|": 3, "d1|q2": 7, "d2|": 9 };
    expect(fieldCommentCountOf(counts, "d1", "q1")).toBe(5);
    expect(fieldCommentCountOf(counts, "d2", "q1")).toBe(9);
    expect(fieldCommentCountOf({}, "d1", "q1")).toBe(0);
  });
});

describe("fieldPanelPropsOf", () => {
  it("usa a descrição como rótulo, ou o nome quando não há", () => {
    expect(
      fieldPanelPropsOf(
        { id: "f1", name: "q1", type: "single", options: ["a"], description: "Pergunta 1", help_text: "ajuda" },
        "q1",
      ),
    ).toEqual({
      fieldName: "q1",
      fieldDescription: "Pergunta 1",
      fieldHelpText: "ajuda",
      fieldType: "single",
      fieldOptions: ["a"],
    });
    expect(fieldPanelPropsOf(undefined, "q1")).toEqual({
      fieldName: "q1",
      fieldDescription: "q1",
      fieldHelpText: undefined,
      fieldType: undefined,
      fieldOptions: undefined,
    });
  });
});

describe("docTitleOf", () => {
  it("título, depois id externo, depois o genérico", () => {
    expect(docTitleOf({ ...doc("d1"), title: "T" })).toBe("T");
    expect(docTitleOf({ ...doc("d1"), title: null, external_id: "EXT" })).toBe("EXT");
    expect(docTitleOf({ ...doc("d1"), title: null })).toBe("Documento");
  });
});
