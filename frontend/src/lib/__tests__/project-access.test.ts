import { describe, it, expect } from "vitest";
import { coordinatorGate } from "@/lib/project-access";

// A escolha fail-open vs fail-closed é a decisão de segurança central da
// centralização de `isCoordinator`: páginas que recortam DADOS por papel
// (compare, my-verdicts) precisam ser fail-CLOSED, enquanto páginas onde
// `isCoordinator` só liga affordances re-checadas na mutation (rounds,
// comments, llm-insights) podem ser fail-OPEN. Estes testes travam essa
// fronteira para que uma edição futura não a inverta silenciosamente.
describe("coordinatorGate — fronteira fail-open vs fail-closed", () => {
  const coordinator = { isCoordinator: true, queryFailed: false };
  const naoCoordenador = { isCoordinator: false, queryFailed: false };
  const erroTransitorio = { isCoordinator: false, queryFailed: true };

  it("access null → sempre false (independente do flag)", () => {
    expect(coordinatorGate(null, { failOpen: true })).toBe(false);
    expect(coordinatorGate(null, { failOpen: false })).toBe(false);
  });

  it("coordenador → true nos dois modos", () => {
    expect(coordinatorGate(coordinator, { failOpen: true })).toBe(true);
    expect(coordinatorGate(coordinator, { failOpen: false })).toBe(true);
  });

  it("não-coordenador sem erro → false nos dois modos", () => {
    expect(coordinatorGate(naoCoordenador, { failOpen: true })).toBe(false);
    expect(coordinatorGate(naoCoordenador, { failOpen: false })).toBe(false);
  });

  // O par decisivo: o MESMO estado (erro transitório de query) resolve
  // diferente conforme o flag.
  it("erro transitório + fail-open → true (não rebaixa coordenador legítimo)", () => {
    expect(coordinatorGate(erroTransitorio, { failOpen: true })).toBe(true);
  });

  it("erro transitório + fail-closed → false (NÃO expõe dados de terceiros)", () => {
    // Invariante de segurança: fail-closed jamais incorpora queryFailed.
    expect(coordinatorGate(erroTransitorio, { failOpen: false })).toBe(false);
  });
});
