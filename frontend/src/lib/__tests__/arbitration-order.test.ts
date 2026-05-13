import { describe, it, expect } from "vitest";
import { assignOrder } from "@/lib/arbitration-order";

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
