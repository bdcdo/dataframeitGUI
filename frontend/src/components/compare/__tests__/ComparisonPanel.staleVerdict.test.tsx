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
const STALE = { verdict: "Sim", chosenResponseId: "r1", comment: "visto antes" };

describe("ComparisonPanel: veredito anterior à mudança da pergunta", () => {
  it("sem veredito válido, mostra o antigo com o rótulo de referência", () => {
    render(<ComparisonPanel {...panelProps({ staleVerdict: STALE })} />);
    expect(screen.getByText(/Veredito anterior à mudança da pergunta/)).toBeTruthy();
    expect(screen.getByText("Sim")).toBeTruthy();
    expect(screen.queryByText(/^Veredito anterior:/)).toBeNull();
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
