// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { LlmErrorCard } from "@/components/stats/LlmErrorCard";
import type { LlmError, LlmErrorSource } from "@/lib/llm-error-metrics";

function llmError(source: LlmErrorSource): LlmError {
  return {
    documentId: "doc1",
    documentTitle: "Documento 1",
    fieldName: "x",
    fieldDescription: "Pergunta x",
    llmAnswer: "NI",
    llmJustification: null,
    chosenVerdict: "N/A",
    reviewerComment: null,
    resolvedAt: null,
    reviewedAt: "2026-02-01T00:00:00Z",
    schemaVersion: "1.0.0",
    llmResponseId: "rllm",
    chosenResponseId: "rh",
    source,
  };
}

function renderCard(source: LlmErrorSource) {
  render(
    <LlmErrorCard
      error={llmError(source)}
      projectId="proj1"
      isPending={false}
      onDecide={vi.fn()}
      onReopen={vi.fn()}
      onMarkEquivalent={vi.fn()}
    />,
  );
}

afterEach(cleanup);

describe("LlmErrorCard — affordance de equivalência", () => {
  it("oferece 'marcar como equivalente' em erro vindo da Comparação", () => {
    renderCard("comparacao");

    expect(screen.getByTitle("Marcar respostas como equivalentes")).toBeTruthy();
  });

  // `markLlmEquivalent` grava em `response_equivalences`, e a classificação da
  // auto-revisão lê só `provenance`/`final_verdict` de `field_reviews`: ali o
  // botão daria toast de sucesso e devolveria o mesmo erro intacto (#705).
  it("esconde o botão em erro vindo da auto-revisão", () => {
    renderCard("auto_revisao");

    expect(screen.queryByTitle("Marcar respostas como equivalentes")).toBeNull();
  });
});

describe("LlmErrorCard — veredito anterior em branco", () => {
  it("mostra (vazio) em vez de um rótulo sem conteúdo", () => {
    render(
      <LlmErrorCard error={{ ...llmError("comparacao"), llmAnswer: "A", chosenVerdict: "" }} projectId="proj1"
        isPending={false} onDecide={vi.fn()} onReopen={vi.fn()} onMarkEquivalent={vi.fn()} />,
    );
    expect(screen.getByText("Veredito anterior:").nextElementSibling?.textContent).toBe("(vazio)");
  });
});

describe("LlmErrorCard: decisão sobre veredito que perdeu a validade", () => {
  const resolution = {
    id: "res1", project_id: "proj1", document_id: "doc1", field_name: "x",
    decision: "llm_correct" as const, context: null, current_context: null,
    resolved_at: "2026-09-14T12:00:00Z", resolved_by: "u1", note: null,
  };

  function renderInvalid(onDecide = vi.fn(), onReopen = vi.fn()) {
    render(
      <LlmErrorCard
        error={{ ...llmError("comparacao"), sourceId: "review1", sourceInvalidReason: "pergunta_alterada", resolution }}
        projectId="proj1" isPending={false} canResolve onDecide={onDecide} onReopen={onReopen}
      />,
    );
    return { onDecide, onReopen };
  }

  it("mantém redecidíveis as decisões que gravam valor próprio", () => {
    const { onDecide } = renderInvalid();
    for (const label of ["Erro humano", "Erro do LLM", "Todos errados"]) {
      const button = screen.getByRole("button", { name: label }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      button.click();
    }
    expect(onDecide.mock.calls.map(([d]) => d)).toEqual(["llm_correct", "researchers_correct", "all_wrong"]);
  });

  it("desabilita Ambos corretos e Em discussão e diz por quê", () => {
    renderInvalid();
    for (const label of ["Ambos corretos", "Em discussão"]) {
      expect((screen.getByRole("button", { name: label }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(screen.getByText(/dependem do veredito anterior/)).toBeTruthy();
  });

  it("rotula o veredito anterior como sem validade, com o motivo", () => {
    renderInvalid();
    expect(screen.getByText("Veredito anterior à mudança da pergunta (sem validade):")).toBeTruthy();
    expect(screen.queryByText("Veredito anterior:")).toBeNull();
  });

  // O rótulo diz o motivo real, e não "mudança da pergunta" para todos.
  it.each([
    ["fora_do_dominio" as const, "Veredito fora das opções atuais da pergunta (sem validade):"],
    ["campo_removido" as const, "Veredito de pergunta removida do formulário (sem validade):"],
    ["veredito_apagado" as const, "Veredito anterior apagado (sem validade):"],
  ])("motivo %s rotula o veredito pelo motivo", (sourceInvalidReason, label) => {
    render(
      <LlmErrorCard
        error={{ ...llmError("comparacao"), sourceId: "review1", sourceInvalidReason, resolution }}
        projectId="proj1" isPending={false} canResolve onDecide={vi.fn()} onReopen={vi.fn()}
      />,
    );
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByText(/mudança da pergunta/)).toBeNull();
  });

  it("Reabrir continua funcionando", () => {
    const { onReopen } = renderInvalid();
    const reopen = screen.getByRole("button", { name: /Reabrir/ }) as HTMLButtonElement;
    expect(reopen.disabled).toBe(false);
    reopen.click();
    expect(onReopen).toHaveBeenCalledTimes(1);
  });

  it("com a fonte válida, todas as decisões ficam ativas", () => {
    render(
      <LlmErrorCard error={{ ...llmError("comparacao"), sourceId: "review1" }} projectId="proj1"
        isPending={false} canResolve onDecide={vi.fn()} onReopen={vi.fn()} />,
    );
    for (const label of ["Erro humano", "Erro do LLM", "Ambos corretos", "Todos errados", "Em discussão"]) {
      expect((screen.getByRole("button", { name: label }) as HTMLButtonElement).disabled).toBe(false);
    }
    expect(screen.getByText("Veredito anterior:")).toBeTruthy();
  });
});

// #758: o veredito anterior pode ser de uma arbitragem antiga. O card mostra
// ao lado dele o que os pesquisadores respondem agora, para que quem revisa
// veja que eles e o LLM concordam antes de escolher a decisão.
describe("LlmErrorCard — respostas atuais dos pesquisadores", () => {
  function renderWith(currentHumanAnswers: LlmError["currentHumanAnswers"]) {
    render(
      <LlmErrorCard error={{ ...llmError("comparacao"), llmAnswer: "Sim", chosenVerdict: "Não", currentHumanAnswers }}
        projectId="proj1" isPending={false} onDecide={vi.fn()} onReopen={vi.fn()} onMarkEquivalent={vi.fn()} />,
    );
  }

  it("lista cada pesquisador com a resposta atual, ao lado do veredito anterior", () => {
    renderWith([{ name: "Ana", answer: "Sim" }, { name: "Beto", answer: "" }]);
    const block = screen.getByText("Pesquisadores agora:").parentElement!;
    expect(block.textContent).toContain("Ana");
    expect(block.textContent).toContain("Sim");
    expect(block.textContent).toContain("Beto");
    expect(block.textContent).toContain("(vazio)");
    expect(screen.getByText("Veredito anterior:")).toBeTruthy();
  });

  it("sem resposta humana corrente, diz isso em vez de sumir", () => {
    renderWith([]);
    expect(screen.getByText("Pesquisadores agora:").parentElement!.textContent).toContain("nenhuma resposta atual");
  });
});
