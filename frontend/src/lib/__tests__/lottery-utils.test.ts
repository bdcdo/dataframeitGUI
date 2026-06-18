import { describe, it, expect } from "vitest";
import {
  createRng,
  distributeDocs,
  filterEligibleDocs,
  type LotteryBalancing,
  type LotteryDocStats,
  type LotteryParticipant,
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

describe("distributeDocs", () => {
  const docIds = (n: number) => Array.from({ length: n }, (_, i) => `doc${i}`);

  function makeParticipants(
    loads: number[],
    capacity = Infinity,
  ): LotteryParticipant[] {
    return loads.map((accumulatedLoad, i) => ({
      id: `p${i}`,
      accumulatedLoad,
      capacity,
    }));
  }

  function emptyCoOccurrence(participants: LotteryParticipant[]) {
    const m: Record<string, Record<string, number>> = {};
    for (const a of participants) {
      m[a.id] = {};
      for (const b of participants) m[a.id][b.id] = 0;
    }
    return m;
  }

  function run(
    docs: string[],
    participants: LotteryParticipant[],
    overrides: {
      researchersPerDoc?: number;
      balancing?: LotteryBalancing;
      preservedPairs?: Set<string>;
      docAssignedUsers?: Record<string, string[]>;
      coOccurrence?: Record<string, Record<string, number>>;
      seed?: number;
    } = {},
  ) {
    return distributeDocs(docs, participants, {
      researchersPerDoc: overrides.researchersPerDoc ?? 1,
      balancing: overrides.balancing ?? "round",
      preservedPairs: overrides.preservedPairs ?? new Set(),
      docAssignedUsers: overrides.docAssignedUsers ?? {},
      coOccurrence: overrides.coOccurrence ?? emptyCoOccurrence(participants),
      rng: createRng(overrides.seed ?? 42),
    });
  }

  function countByUser(result: { user_id: string }[]) {
    const counts: Record<string, number> = {};
    for (const a of result) counts[a.user_id] = (counts[a.user_id] || 0) + 1;
    return counts;
  }

  it("modo round distribui uniformemente: novas em ⌊D·R/P⌋..⌈D·R/P⌉ (SC-006)", () => {
    // 12 docs × 1 vaga ÷ 3 participantes = exatamente 4 cada
    const participants = makeParticipants([0, 30, 7]);
    const exact = countByUser(run(docIds(12), participants));
    expect(Object.values(exact)).toEqual([4, 4, 4]);

    // 14 docs × 2 vagas ÷ 5 participantes = 28/5 → 5 ou 6 cada
    const five = makeParticipants([0, 1, 2, 3, 4]);
    const counts = countByUser(
      run(docIds(14), five, { researchersPerDoc: 2 }),
    );
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(28);
    for (const c of Object.values(counts)) {
      expect(c).toBeGreaterThanOrEqual(5);
      expect(c).toBeLessThanOrEqual(6);
    }
  });

  it("modo history nivela pela carga acumulada (SC-007)", () => {
    // p0 carrega 10; com 10 docs novos, p1 e p2 niveladores recebem tudo
    const participants = makeParticipants([10, 0, 0]);
    const counts = countByUser(
      run(docIds(10), participants, { balancing: "history" }),
    );
    expect(counts["p0"]).toBeUndefined();
    expect(counts["p1"]).toBe(5);
    expect(counts["p2"]).toBe(5);
  });

  it("modo history não deixa ninguém levar tudo havendo outros com capacidade", () => {
    const participants = makeParticipants([3, 2, 0]);
    const counts = countByUser(
      run(docIds(20), participants, { balancing: "history" }),
    );
    // todos terminam com carga total ≈ (3+2+0+20)/3
    for (const p of participants) {
      const total = p.accumulatedLoad + (counts[p.id] || 0);
      expect(total).toBeGreaterThanOrEqual(8);
      expect(total).toBeLessThanOrEqual(9);
    }
  });

  it("desempate é aleatório, não a ordem do array de participantes (FR-019)", () => {
    // 1 doc, 4 participantes empatados: em N seeds, cada um é contemplado
    // numa fração aproximadamente uniforme, inclusive os últimos do array
    const participants = makeParticipants([0, 0, 0, 0]);
    const wins: Record<string, number> = {};
    for (let seed = 0; seed < 400; seed++) {
      const [a] = run(["doc0"], participants, { seed });
      wins[a.user_id] = (wins[a.user_id] || 0) + 1;
    }
    expect(Object.keys(wins)).toHaveLength(4);
    for (const w of Object.values(wins)) {
      expect(w).toBeGreaterThan(60); // uniforme ≈ 100 ± folga
      expect(w).toBeLessThan(140);
    }
  });

  it("mesma entrada + mesma seed ⇒ mesmo resultado (base do SC-005)", () => {
    const participants = makeParticipants([2, 0, 5, 1]);
    const a = run(docIds(30), participants, { researchersPerDoc: 2, seed: 7 });
    const b = run(docIds(30), participants, { researchersPerDoc: 2, seed: 7 });
    expect(a).toEqual(b);
    const c = run(docIds(30), participants, { researchersPerDoc: 2, seed: 8 });
    expect(c).not.toEqual(a);
  });

  it("respeita capacity e para quando ninguém tem vaga", () => {
    const participants = makeParticipants([0, 0, 0], 2);
    const result = run(docIds(10), participants);
    const counts = countByUser(result);
    expect(result).toHaveLength(6);
    for (const c of Object.values(counts)) expect(c).toBeLessThanOrEqual(2);
  });

  describe("peso por participante", () => {
    it("weight 0.5 recebe ~metade dos pares de peso 1 (round)", () => {
      // pesos 1, 1, 0.5 → soma 2.5; 50 docs × 1 vaga → p2 ≈ 50·(0.5/2.5) = 10
      const participants: LotteryParticipant[] = [
        { id: "p0", accumulatedLoad: 0, capacity: Infinity, weight: 1 },
        { id: "p1", accumulatedLoad: 0, capacity: Infinity, weight: 1 },
        { id: "p2", accumulatedLoad: 0, capacity: Infinity, weight: 0.5 },
      ];
      const counts = countByUser(run(docIds(50), participants));
      expect(counts.p0 + counts.p1 + counts.p2).toBe(50);
      expect(counts.p2).toBeLessThan(counts.p0);
      expect(counts.p2).toBeLessThan(counts.p1);
      expect(counts.p2).toBeGreaterThanOrEqual(8);
      expect(counts.p2).toBeLessThanOrEqual(12);
    });

    it("weight escala também no modo history", () => {
      // todos partem de 0; alvo do history é nivelar load/weight, então
      // p2 (peso 0.5) termina com ~metade da carga dos demais
      const participants: LotteryParticipant[] = [
        { id: "p0", accumulatedLoad: 0, capacity: Infinity, weight: 1 },
        { id: "p1", accumulatedLoad: 0, capacity: Infinity, weight: 1 },
        { id: "p2", accumulatedLoad: 0, capacity: Infinity, weight: 0.5 },
      ];
      const counts = countByUser(
        run(docIds(50), participants, { balancing: "history" }),
      );
      expect(counts.p2).toBeLessThan(counts.p0);
      expect(counts.p2).toBeLessThan(counts.p1);
      expect(counts.p2).toBeGreaterThanOrEqual(8);
      expect(counts.p2).toBeLessThanOrEqual(12);
    });

    it("weight ausente equivale a peso 1 (regressão)", () => {
      // mesma entrada, com e sem weight=1 explícito → mesmo resultado
      const semWeight = makeParticipants([0, 0, 0]);
      const comWeight: LotteryParticipant[] = semWeight.map((p) => ({
        ...p,
        weight: 1,
      }));
      const a = run(docIds(12), semWeight, { seed: 7 });
      const b = run(docIds(12), comWeight, { seed: 7 });
      expect(a).toEqual(b);
    });
  });

  it("limite individual corta a carga do participante; o resto vai aos demais", () => {
    // p0 com capacity 3 (limite individual); p1 e p2 sem limite absorvem o resto
    const participants: LotteryParticipant[] = [
      { id: "p0", accumulatedLoad: 0, capacity: 3, weight: 1 },
      { id: "p1", accumulatedLoad: 0, capacity: Infinity, weight: 1 },
      { id: "p2", accumulatedLoad: 0, capacity: Infinity, weight: 1 },
    ];
    const counts = countByUser(run(docIds(30), participants));
    expect(counts.p0).toBe(3);
    expect((counts.p1 ?? 0) + (counts.p2 ?? 0)).toBe(27);
  });

  it("nunca duplica par doc+pessoa preservado (preservedPairs)", () => {
    const participants = makeParticipants([0, 0]);
    for (let seed = 0; seed < 20; seed++) {
      const result = run(["doc0"], participants, {
        researchersPerDoc: 2,
        preservedPairs: new Set(["doc0:p0"]),
        docAssignedUsers: { doc0: ["p0"] },
        seed,
      });
      // só resta 1 vaga e p0 nunca pode ocupá-la
      expect(result).toEqual([{ document_id: "doc0", user_id: "p1" }]);
    }
  });

  it("variação de duplas desempata entre cargas iguais (FR-014)", () => {
    // doc0 já tem X; p0 co-ocorre muito com X, p1 e p2 nunca — entre
    // empatados de carga, p0 nunca deve ser escolhido
    const participants = makeParticipants([0, 0, 0]);
    const coOccurrence = emptyCoOccurrence(participants);
    coOccurrence["p0"]["x"] = 5;
    coOccurrence["p1"]["x"] = 0;
    coOccurrence["p2"]["x"] = 0;
    for (let seed = 0; seed < 30; seed++) {
      const [a] = run(["doc0"], participants, {
        researchersPerDoc: 2,
        docAssignedUsers: { doc0: ["x"] },
        coOccurrence,
        seed,
      });
      expect(a.user_id).not.toBe("p0");
    }
  });

  it("não muta os inputs (função pura)", () => {
    const participants = makeParticipants([1, 2]);
    const coOccurrence = emptyCoOccurrence(participants);
    const snapshot = JSON.parse(JSON.stringify(coOccurrence));
    const docs = docIds(5);
    run(docs, participants, { researchersPerDoc: 2, coOccurrence });
    expect(coOccurrence).toEqual(snapshot);
    expect(docs).toEqual(docIds(5));
    expect(participants[0].accumulatedLoad).toBe(1);
  });
});
