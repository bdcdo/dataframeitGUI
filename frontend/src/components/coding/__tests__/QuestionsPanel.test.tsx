// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { QuestionsPanel } from "@/components/coding/QuestionsPanel";
import type { PydanticField } from "@/lib/types";

// Dependências do OutOfScopeToggle (renderizado quando a prop `outOfScope`
// está presente) — inertes nos demais testes.
vi.mock("@/actions/project-comments", () => ({
  requestDocumentExclusion: vi.fn(),
  cancelExclusionRequest: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

afterEach(cleanup);

const q1: PydanticField = {
  name: "q1",
  type: "single",
  options: ["sim", "não"],
  description: "Pergunta gatilho",
};
const q2Conditional: PydanticField = {
  name: "q2",
  type: "single",
  options: ["a", "b"],
  description: "Pergunta condicional",
  condition: { field: "q1", equals: "sim" },
};
const q3: PydanticField = {
  name: "q3",
  type: "text",
  options: null,
  description: "Pergunta final",
};

const baseFields = [q1, q2Conditional, q3];

let scrolledInto: Element[];

beforeEach(() => {
  scrolledInto = [];
  Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
    scrolledInto.push(this);
  });
  // jsdom não implementa matchMedia; getScrollBehavior() depende dele.
  window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as never;
});

function renderPanel(props: {
  fields?: PydanticField[];
  answers: Record<string, unknown>;
  readOnly?: boolean;
}) {
  return render(
    <QuestionsPanel
      fields={props.fields ?? baseFields}
      answers={props.answers}
      onAnswer={vi.fn()}
      onSubmit={vi.fn()}
      readOnly={props.readOnly}
    />,
  );
}

describe("QuestionsPanel — scroll automático em condicional (issue #71)", () => {
  it("não scrolla na hidratação inicial, mesmo com condicional já visível", () => {
    renderPanel({ answers: { q1: "sim" } });
    expect(scrolledInto).toHaveLength(0);
  });

  it("scrolla até a pergunta condicional quando uma resposta a libera", () => {
    const { rerender } = renderPanel({ answers: {} });
    expect(scrolledInto).toHaveLength(0);

    rerender(
      <QuestionsPanel
        fields={baseFields}
        answers={{ q1: "sim" }}
        onAnswer={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(scrolledInto).toHaveLength(1);
    expect(scrolledInto[0].textContent).toContain("Pergunta condicional");
  });

  it("não scrolla ao mudar resposta de pergunta cuja condicional já estava visível", () => {
    const { rerender } = renderPanel({ answers: { q1: "sim" } });
    expect(scrolledInto).toHaveLength(0);

    // q2 continua visível (condição ainda satisfeita); só q2 ganhou resposta.
    rerender(
      <QuestionsPanel
        fields={baseFields}
        answers={{ q1: "sim", q2: "a" }}
        onAnswer={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(scrolledInto).toHaveLength(0);
  });

  it("não scrolla quando a prop fields muda (mudança de schema)", () => {
    const { rerender } = renderPanel({ answers: { q1: "sim" } });
    expect(scrolledInto).toHaveLength(0);

    // Novo array de fields introduz outra condicional já satisfeita: como o
    // gatilho foi mudança de schema (não resposta do usuário), não deve rolar.
    const q4Conditional: PydanticField = {
      name: "q4",
      type: "text",
      options: null,
      description: "Outra condicional",
      condition: { field: "q1", equals: "sim" },
    };
    rerender(
      <QuestionsPanel
        fields={[q1, q2Conditional, q4Conditional, q3]}
        answers={{ q1: "sim" }}
        onAnswer={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(scrolledInto).toHaveLength(0);
  });

  it("scrolla para a primeira condicional quando várias aparecem de uma vez", () => {
    const q2b: PydanticField = {
      name: "q2b",
      type: "text",
      options: null,
      description: "Segunda condicional",
      condition: { field: "q1", equals: "sim" },
    };
    const fields = [q1, q2Conditional, q2b, q3];
    const { rerender } = renderPanel({ fields, answers: {} });

    rerender(
      <QuestionsPanel
        fields={fields}
        answers={{ q1: "sim" }}
        onAnswer={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(scrolledInto).toHaveLength(1);
    expect(scrolledInto[0].textContent).toContain("Pergunta condicional");
  });

  it("não scrolla em readOnly mesmo quando uma condicional é liberada", () => {
    const { rerender } = renderPanel({ answers: {}, readOnly: true });
    expect(scrolledInto).toHaveLength(0);

    rerender(
      <QuestionsPanel
        fields={baseFields}
        answers={{ q1: "sim" }}
        onAnswer={vi.fn()}
        onSubmit={vi.fn()}
        readOnly
      />,
    );

    expect(scrolledInto).toHaveLength(0);
  });
});

describe("QuestionsPanel — pergunta fora do escopo", () => {
  const outOfScopeBase = {
    projectId: "p1",
    documentId: "d1",
    documentTitle: "Doc Um",
  };

  it("sem a prop outOfScope não renderiza o toggle", () => {
    renderPanel({ answers: {} });
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("renderiza o toggle como primeiro elemento do painel", () => {
    render(
      <QuestionsPanel
        fields={baseFields}
        answers={{}}
        onAnswer={vi.fn()}
        onSubmit={vi.fn()}
        outOfScope={{ ...outOfScopeBase, initialState: { status: "normal" } }}
      />,
    );
    expect(screen.getByRole("switch")).toBeTruthy();
    // Formulário não bloqueado: botão de envio normal.
    expect(screen.getByRole("button", { name: /Enviar respostas/ })).toBeTruthy();
  });

  it("pendente: perguntas inertes e envio substituído por aviso", () => {
    const onSubmit = vi.fn();
    render(
      <QuestionsPanel
        fields={baseFields}
        answers={{ q1: "sim" }}
        onAnswer={vi.fn()}
        onSubmit={onSubmit}
        outOfScope={{
          ...outOfScopeBase,
          initialState: { status: "pending_mine", reason: "fora do tema" },
        }}
      />,
    );
    const submit = screen.getByRole("button", {
      name: /Aguardando revisão do coordenador/,
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    // Bloco de perguntas esmaecido e sem resposta a mouse.
    const blocked = document.querySelector('[aria-disabled="true"]');
    expect(blocked?.className).toContain("pointer-events-none");
    // O toggle segue interativo (fora do bloco) para permitir desfazer.
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(false);
  });

  it("pendente por outro pesquisador: toggle desabilitado e envio bloqueado", () => {
    render(
      <QuestionsPanel
        fields={baseFields}
        answers={{}}
        onAnswer={vi.fn()}
        onSubmit={vi.fn()}
        outOfScope={{
          ...outOfScopeBase,
          initialState: { status: "pending_other" },
        }}
      />,
    );
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", {
        name: /Aguardando revisão do coordenador/,
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("QuestionsPanel — validação de campo composto", () => {
  const compositeField: PydanticField = {
    name: "dados",
    type: "text",
    options: null,
    description: "Dados pessoais",
    required: true,
    subfield_rule: "all",
    subfields: [
      { key: "nome", label: "Nome", required: true },
      { key: "cidade", label: "Cidade", required: false },
    ],
  };

  function CompositeHarness({ onSubmit }: { onSubmit: () => void }) {
    const [answers, setAnswers] = useState<Record<string, unknown>>({});
    return (
      <QuestionsPanel
        fields={[compositeField]}
        answers={answers}
        onAnswer={(name, value) =>
          setAnswers((current) => ({ ...current, [name]: value }))
        }
        onSubmit={onSubmit}
      />
    );
  }

  it("mantém o destaque até o grupo ficar válido e expõe estado acessível", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<CompositeHarness onSubmit={onSubmit} />);

    await user.click(screen.getByRole("button", { name: "Enviar respostas" }));
    const group = screen.getByRole("group");
    const nameInput = screen.getByPlaceholderText("Nome");
    const cityInput = screen.getByPlaceholderText("Cidade");
    expect(group.getAttribute("data-invalid")).toBe("true");
    expect(group.getAttribute("aria-describedby")).toContain(
      "dados-subfield-validation",
    );
    expect(nameInput.getAttribute("aria-required")).toBe("true");
    expect(nameInput.getAttribute("aria-invalid")).toBe("true");
    expect(cityInput.getAttribute("aria-required")).toBe("false");

    await user.type(cityInput, "Recife");
    expect(group.getAttribute("data-invalid")).toBe("true");
    expect(onSubmit).not.toHaveBeenCalled();

    await user.type(nameInput, "Ana");
    expect(group.getAttribute("data-invalid")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Enviar respostas" }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});
