import { describe, it, expect } from "vitest";
import { buildRetriableToggleMessage } from "../useTogglePermission";

describe("buildRetriableToggleMessage", () => {
  it("sem retried, retorna só o verbo", () => {
    expect(buildRetriableToggleMessage("Arbitragem habilitada", "árbitro")).toBe(
      "Arbitragem habilitada."
    );
  });

  it("com casos realocados e ainda sem pool, detalha os dois números", () => {
    const msg = buildRetriableToggleMessage("Arbitragem habilitada", "árbitro", {
      assigned: 2,
      stillNoPool: 1,
    });
    expect(msg).toBe(
      "Arbitragem habilitada. 2 caso(s) realocado(s); 1 ainda sem árbitro elegível."
    );
  });

  it("com casos realocados e nenhum restante sem pool, omite a segunda parte", () => {
    const msg = buildRetriableToggleMessage("Comparação habilitada", "revisor", {
      assigned: 3,
      stillNoPool: 0,
    });
    expect(msg).toBe("Comparação habilitada. 3 caso(s) realocado(s).");
  });

  it("com retried mas assigned=0, degrada para a mensagem simples", () => {
    const msg = buildRetriableToggleMessage("Comparação desabilitada", "revisor", {
      assigned: 0,
      stillNoPool: 0,
    });
    expect(msg).toBe("Comparação desabilitada.");
  });
});
