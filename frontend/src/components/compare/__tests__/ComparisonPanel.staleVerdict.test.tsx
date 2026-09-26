// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("@/components/shared/AddNoteButton", () => ({
  AddNoteButton: () => <button type="button">Anotar</button>,
}));
vi.mock("@/components/stats/SuggestFieldDialog", () => ({
  SuggestFieldDialog: () => null,
}));

import { ComparisonPanel } from "@/components/compare/ComparisonPanel";
import { panelProps } from "./compare-test-helpers";

afterEach(cleanup);

// Veredito do revisor dado sobre outra versão da pergunta (#758): a célula
// pede arbitragem de novo, e o veredito antigo aparece só como referência.
const STALE = { verdict: "Sim", chosenResponseId: "r1", comment: "visto antes", invalidReason: "pergunta_alterada" as const };

describe("ComparisonPanel: veredito anterior à mudança da pergunta", () => {
  it("sem veredito válido, mostra o antigo com o rótulo de referência", () => {
    render(<ComparisonPanel {...panelProps({ staleVerdict: STALE })} />);
    expect(screen.getByText(/Veredito anterior à mudança da pergunta/)).toBeTruthy();
    expect(screen.getByText("Sim")).toBeTruthy();
    expect(screen.queryByText(/^Veredito anterior:/)).toBeNull();
  });

  // O rótulo diz o motivo real: o voto copiado de resposta que saiu das
  // opções não é "anterior à mudança da pergunta".
  it.each([
    ["fora_do_dominio" as const, "Veredito fora das opções atuais da pergunta"],
    ["campo_removido" as const, "Veredito de pergunta removida do formulário"],
  ])("motivo %s mostra o rótulo do motivo", (invalidReason, label) => {
    render(<ComparisonPanel {...panelProps({ staleVerdict: { ...STALE, invalidReason } })} />);
    expect(screen.getByText(new RegExp(label))).toBeTruthy();
    expect(screen.queryByText(/mudança da pergunta/)).toBeNull();
  });

  it("com veredito válido, o antigo some e fica o rótulo de sempre", () => {
    render(
      <ComparisonPanel
        {...panelProps({
          staleVerdict: STALE,
          existingVerdict: { verdict: "Não", chosenResponseId: null, comment: null },
        })}
      />,
    );
    expect(screen.queryByText(/mudança da pergunta/)).toBeNull();
    expect(screen.getByText(/Veredito anterior:/)).toBeTruthy();
  });
});
