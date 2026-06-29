// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { RevealPhase } from "../RevealPhase";
import type { ArbitrationField } from "../ArbitrationPage";
import type { ArbitrationVerdict, PydanticField } from "@/lib/types";

afterEach(cleanup);

function field(over: Partial<ArbitrationField> = {}): ArbitrationField {
  return {
    fieldReviewId: "f1",
    fieldName: "q1",
    aAnswer: "valorA",
    bAnswer: "valorB",
    blindVerdict: "humano",
    reveal: {
      aSide: "humano",
      bSide: "llm",
      humanName: "Ana",
      llmName: "GPT",
      llmJustification: "Porque LLM",
      selfJustification: "Porque humano",
    },
    ...over,
  };
}

const meta = new Map<string, PydanticField>([
  ["q1", { name: "q1", type: "single", options: null, description: "desc q1" }],
]);

function renderReveal(over: {
  field?: Partial<ArbitrationField>;
  arbitrationBlind?: boolean;
  finalChoices?: Record<string, ArbitrationVerdict>;
  suggestions?: Record<string, string>;
  comments?: Record<string, string>;
} = {}) {
  const handlers = {
    onChooseFinal: vi.fn<(id: string, v: ArbitrationVerdict) => void>(),
    onSuggestion: vi.fn<(id: string, v: string) => void>(),
    onComment: vi.fn<(id: string, v: string) => void>(),
  };
  render(
    <RevealPhase
      fields={[field(over.field)]}
      fieldMeta={meta}
      arbitrationBlind={over.arbitrationBlind ?? false}
      finalChoices={over.finalChoices ?? {}}
      suggestions={over.suggestions ?? {}}
      comments={over.comments ?? {}}
      {...handlers}
    />,
  );
  return handlers;
}

describe("RevealPhase — rótulos por modo", () => {
  it("arbitration_blind=false: mostra nomes Humano/LLM", () => {
    renderReveal({ arbitrationBlind: false });
    expect(screen.getByText("Humano (Ana)")).toBeTruthy();
    expect(screen.getByText("LLM (GPT)")).toBeTruthy();
  });

  it("arbitration_blind=true: mostra Resposta A/B em vez dos papéis", () => {
    renderReveal({ arbitrationBlind: true });
    expect(screen.getByText("Resposta A")).toBeTruthy();
    expect(screen.getByText("Resposta B")).toBeTruthy();
    expect(screen.queryByText("Humano (Ana)")).toBeNull();
  });
});

describe("RevealPhase — escolha final", () => {
  it("clicar em 'Humano acertou' / 'LLM acertou' chama onChooseFinal", () => {
    const h = renderReveal();
    fireEvent.click(screen.getByRole("button", { name: "Humano acertou" }));
    expect(h.onChooseFinal).toHaveBeenCalledWith("f1", "humano");
    fireEvent.click(screen.getByRole("button", { name: "LLM acertou" }));
    expect(h.onChooseFinal).toHaveBeenCalledWith("f1", "llm");
  });

  it("avisa quando o árbitro mudou de ideia (final != veredito cego)", () => {
    renderReveal({ finalChoices: { f1: "llm" } }); // blindVerdict é "humano"
    expect(
      screen.getByText(/Você mudou de ideia após ver a justificativa/),
    ).toBeTruthy();
  });

  it("não avisa quando final coincide com o veredito cego", () => {
    renderReveal({ finalChoices: { f1: "humano" } });
    expect(
      screen.queryByText(/Você mudou de ideia/),
    ).toBeNull();
  });
});

describe("RevealPhase — sugestão e comentário", () => {
  it("textarea de sugestão aparece só quando final === 'llm'", () => {
    const placeholder =
      "Como reformular a pergunta para evitar essa divergência no futuro?";
    renderReveal({ finalChoices: { f1: "humano" } });
    expect(screen.queryByPlaceholderText(placeholder)).toBeNull();
    cleanup();
    renderReveal({ finalChoices: { f1: "llm" } });
    expect(screen.getByPlaceholderText(placeholder)).toBeTruthy();
  });

  it("digitar na sugestão chama onSuggestion", () => {
    const h = renderReveal({ finalChoices: { f1: "llm" } });
    const ta = screen.getByPlaceholderText(
      "Como reformular a pergunta para evitar essa divergência no futuro?",
    );
    fireEvent.change(ta, { target: { value: "reformular X" } });
    expect(h.onSuggestion).toHaveBeenCalledWith("f1", "reformular X");
  });

  it("digitar no comentário chama onComment", () => {
    const h = renderReveal();
    const ta = screen.getByLabelText("Comentário (opcional)");
    fireEvent.change(ta, { target: { value: "meu comentário" } });
    expect(h.onComment).toHaveBeenCalledWith("f1", "meu comentário");
  });
});

describe("RevealPhase — justificativas", () => {
  it("exibe as justificativas quando presentes", () => {
    renderReveal();
    expect(screen.getByText("Porque humano")).toBeTruthy();
    expect(screen.getByText("Porque LLM")).toBeTruthy();
  });

  it("usa textos de fallback quando faltam justificativas", () => {
    renderReveal({
      field: {
        reveal: {
          aSide: "humano",
          bSide: "llm",
          humanName: null,
          llmName: null,
          llmJustification: null,
          selfJustification: null,
        },
      },
    });
    expect(
      screen.getByText("Sem justificativa registrada para este campo."),
    ).toBeTruthy();
    expect(
      screen.getByText("LLM não forneceu justificativa para este campo."),
    ).toBeTruthy();
  });
});
