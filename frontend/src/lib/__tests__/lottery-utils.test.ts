import { describe, it, expect } from "vitest";
import {
  filterEligibleDocs,
  type LotteryDocStats,
} from "@/lib/lottery-utils";

function doc(overrides: Partial<LotteryDocStats> & { id: string }): LotteryDocStats {
  return {
    externalId: null,
    title: null,
    humanCodingCount: 0,
    activeAssignments: { codificacao: 0, comparacao: 0 },
    hasAnyAssignmentEver: false,
    batchIds: [],
    ...overrides,
  };
}

const ids = (docs: LotteryDocStats[]) => docs.map((d) => d.id);

describe("filterEligibleDocs", () => {
  it("sem filtros, retorna todos os documentos", () => {
    const docs = [doc({ id: "a" }), doc({ id: "b" })];
    expect(ids(filterEligibleDocs(docs, "codificacao", {}))).toEqual(["a", "b"]);
  });

  describe("maxHumanCodings", () => {
    const docs = [
      doc({ id: "zero", humanCodingCount: 0 }),
      doc({ id: "um", humanCodingCount: 1 }),
      doc({ id: "dois", humanCodingCount: 2 }),
    ];

    it("0 = somente docs sem nenhuma codificação humana", () => {
      expect(
        ids(filterEligibleDocs(docs, "codificacao", { maxHumanCodings: 0 })),
      ).toEqual(["zero"]);
    });

    it("N = docs com no máximo N codificações", () => {
      expect(
        ids(filterEligibleDocs(docs, "codificacao", { maxHumanCodings: 1 })),
      ).toEqual(["zero", "um"]);
    });

    it("undefined = não filtra", () => {
      expect(ids(filterEligibleDocs(docs, "codificacao", {}))).toEqual([
        "zero",
        "um",
        "dois",
      ]);
    });
  });

  describe("assignmentFilter", () => {
    const docs = [
      doc({ id: "livre" }),
      doc({
        id: "cod-ativa",
        activeAssignments: { codificacao: 1, comparacao: 0 },
        hasAnyAssignmentEver: true,
      }),
      doc({
        id: "comp-ativa",
        activeAssignments: { codificacao: 0, comparacao: 1 },
        hasAnyAssignmentEver: true,
      }),
      doc({
        id: "ja-teve",
        activeAssignments: { codificacao: 0, comparacao: 0 },
        hasAnyAssignmentEver: true,
      }),
    ];

    it("noActiveOfType olha só o tipo sorteado", () => {
      expect(
        ids(
          filterEligibleDocs(docs, "codificacao", {
            assignmentFilter: "noActiveOfType",
          }),
        ),
      ).toEqual(["livre", "comp-ativa", "ja-teve"]);
      expect(
        ids(
          filterEligibleDocs(docs, "comparacao", {
            assignmentFilter: "noActiveOfType",
          }),
        ),
      ).toEqual(["livre", "cod-ativa", "ja-teve"]);
    });

    it("neverAssigned exclui docs com qualquer atribuição em qualquer status", () => {
      expect(
        ids(
          filterEligibleDocs(docs, "codificacao", {
            assignmentFilter: "neverAssigned",
          }),
        ),
      ).toEqual(["livre"]);
    });

    it("any não filtra", () => {
      expect(
        ids(filterEligibleDocs(docs, "codificacao", { assignmentFilter: "any" })),
      ).toHaveLength(4);
    });
  });

  describe("batchFilter", () => {
    const docs = [
      doc({ id: "l1", batchIds: ["b1"] }),
      doc({ id: "l1l2", batchIds: ["b1", "b2"] }),
      doc({ id: "l2", batchIds: ["b2"] }),
      doc({ id: "sem-lote", batchIds: [] }),
    ];

    it("only restringe a docs com atribuições do lote", () => {
      expect(
        ids(
          filterEligibleDocs(docs, "codificacao", {
            batchFilter: { only: "b1" },
          }),
        ),
      ).toEqual(["l1", "l1l2"]);
    });

    it("exclude remove docs com qualquer vínculo aos lotes excluídos", () => {
      expect(
        ids(
          filterEligibleDocs(docs, "codificacao", {
            batchFilter: { exclude: ["b1"] },
          }),
        ),
      ).toEqual(["l2", "sem-lote"]);
    });

    it("exclude com múltiplos lotes", () => {
      expect(
        ids(
          filterEligibleDocs(docs, "codificacao", {
            batchFilter: { exclude: ["b1", "b2"] },
          }),
        ),
      ).toEqual(["sem-lote"]);
    });
  });

  describe("manualDocIds", () => {
    const docs = [
      doc({ id: "a", humanCodingCount: 0 }),
      doc({ id: "b", humanCodingCount: 3 }),
      doc({ id: "c", humanCodingCount: 0 }),
    ];

    it("restringe aos docs marcados", () => {
      expect(
        ids(
          filterEligibleDocs(docs, "codificacao", { manualDocIds: ["a", "b"] }),
        ),
      ).toEqual(["a", "b"]);
    });

    it("manual ∩ filtros compõe por interseção", () => {
      expect(
        ids(
          filterEligibleDocs(docs, "codificacao", {
            manualDocIds: ["a", "b"],
            maxHumanCodings: 0,
          }),
        ),
      ).toEqual(["a"]);
    });

    it("seleção manual vazia produz zero elegíveis", () => {
      expect(
        filterEligibleDocs(docs, "codificacao", { manualDocIds: [] }),
      ).toEqual([]);
    });
  });

  it("composição de todos os filtros por interseção", () => {
    const docs = [
      doc({ id: "passa", humanCodingCount: 1, batchIds: ["b2"] }),
      doc({ id: "muita-cod", humanCodingCount: 2, batchIds: ["b2"] }),
      doc({
        id: "ativa",
        humanCodingCount: 0,
        activeAssignments: { codificacao: 1, comparacao: 0 },
        hasAnyAssignmentEver: true,
        batchIds: ["b2"],
      }),
      doc({ id: "lote-excluido", humanCodingCount: 0, batchIds: ["b1"] }),
      doc({ id: "fora-do-manual", humanCodingCount: 0, batchIds: ["b2"] }),
    ];
    expect(
      ids(
        filterEligibleDocs(docs, "codificacao", {
          manualDocIds: ["passa", "muita-cod", "ativa", "lote-excluido"],
          maxHumanCodings: 1,
          assignmentFilter: "noActiveOfType",
          batchFilter: { exclude: ["b1"] },
        }),
      ),
    ).toEqual(["passa"]);
  });

  it("combinação sem sobreviventes retorna vazio", () => {
    const docs = [doc({ id: "a", humanCodingCount: 5 })];
    expect(
      filterEligibleDocs(docs, "codificacao", { maxHumanCodings: 0 }),
    ).toEqual([]);
  });
});
