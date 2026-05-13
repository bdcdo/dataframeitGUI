import { describe, it, expect } from "vitest";
import { assignOrder, resolveBlindVerdict } from "@/lib/arbitration-order";

describe("assignOrder", () => {
  it("é deterministico para o mesmo input", () => {
    const id = "abc-123";
    const a = assignOrder(id);
    const b = assignOrder(id);
    expect(a).toBe(b);
  });

  it("retorna apenas human_first ou llm_first", () => {
    for (const id of ["", "a", "x".repeat(50), "00000000-0000-0000-0000-000000000000"]) {
      const r = assignOrder(id);
      expect(r === "human_first" || r === "llm_first").toBe(true);
    }
  });

  it("produz distribuição razoavelmente equilibrada sobre UUIDs reais", () => {
    // 200 IDs aleatorios — esperamos ~50/50, aceitamos qualquer split
    // que nao seja extremo (mais ruido aceitavel sobre amostra pequena).
    let humanFirst = 0;
    for (let i = 0; i < 200; i++) {
      const id = crypto.randomUUID();
      if (assignOrder(id) === "human_first") humanFirst++;
    }
    expect(humanFirst).toBeGreaterThan(60);
    expect(humanFirst).toBeLessThan(140);
  });

  it("regressao: snapshot de ordem para IDs fixos garante estabilidade", () => {
    // Mudar esses valores significa que arbitragens em andamento mudariam
    // de A/B no meio do processo — se precisar mudar o algoritmo, ajustar
    // intencionalmente este snapshot.
    expect(assignOrder("00000000-0000-0000-0000-000000000001")).toBe(
      "llm_first",
    );
    expect(assignOrder("11111111-1111-1111-1111-111111111111")).toBe(
      "human_first",
    );
    expect(assignOrder("field-review-a")).toBe("llm_first");
    expect(assignOrder("field-review-b")).toBe("human_first");
  });
});

describe("resolveBlindVerdict", () => {
  it("human_first + a → humano (A esta na posicao do humano)", () => {
    // 11111111... → human_first (do snapshot acima)
    expect(resolveBlindVerdict("11111111-1111-1111-1111-111111111111", "a")).toBe(
      "humano",
    );
    expect(resolveBlindVerdict("11111111-1111-1111-1111-111111111111", "b")).toBe(
      "llm",
    );
  });

  it("llm_first + a → llm (A esta na posicao do LLM)", () => {
    // 00000000...001 → llm_first (do snapshot)
    expect(resolveBlindVerdict("00000000-0000-0000-0000-000000000001", "a")).toBe(
      "llm",
    );
    expect(resolveBlindVerdict("00000000-0000-0000-0000-000000000001", "b")).toBe(
      "humano",
    );
  });

  it("round-trip: escolher A sempre devolve o que assignOrder mapeia para A", () => {
    for (let i = 0; i < 50; i++) {
      const id = crypto.randomUUID();
      const order = assignOrder(id);
      const aVerdict = resolveBlindVerdict(id, "a");
      const bVerdict = resolveBlindVerdict(id, "b");
      if (order === "human_first") {
        expect(aVerdict).toBe("humano");
        expect(bVerdict).toBe("llm");
      } else {
        expect(aVerdict).toBe("llm");
        expect(bVerdict).toBe("humano");
      }
      // a e b sempre devolvem veredictos diferentes
      expect(aVerdict).not.toBe(bVerdict);
    }
  });
});
