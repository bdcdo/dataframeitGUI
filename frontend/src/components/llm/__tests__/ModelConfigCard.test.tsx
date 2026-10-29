// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { warmUpJsdom } from "@/test-utils/jsdom-warm-up";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { toggleLlmField } = vi.hoisted(() => ({ toggleLlmField: vi.fn() }));
const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/actions/schema", () => ({ toggleLlmField }));
vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

import { ModelConfigCard } from "@/components/llm/ModelConfigCard";
import { LLM_AMBIGUITIES_FIELD } from "@/lib/standard-questions";

const baseProps = {
  projectId: "p1",
  config: {
    llm_provider: "anthropic" as const,
    llm_model: "claude-test",
    llm_kwargs: {},
  },
  setConfig: vi.fn(),
  pydanticFields: [] as { name: string }[],
  schemaBaseline: { revision: 0 },
};

// O primeiro teste deste arquivo pagava o carregamento a frio de React DOM,
// Testing Library, user-event e Radix e estourava os 5 s com a suíte
// disputando a CPU (src/test-utils/jsdom-warm-up.tsx). O card monta o Popover
// do ModelCombobox, e por isso o aquecimento usa `select: true`, que percorre o
// caminho de Popper: com a suíte em 200% de CPU, o primeiro teste ficou abaixo
// do medido sem ele nas duas séries de rodadas do PR #819.
beforeAll(() => warmUpJsdom({ select: true }), 30_000);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// O segundo switch é o de ambiguidades (o primeiro é "justificativas").
function ambiguitiesSwitch() {
  return screen.getAllByRole("switch")[1];
}

describe("ModelConfigCard — toggle de ambiguidades", () => {
  it("chama toggleLlmField com LLM_AMBIGUITIES_FIELD e mostra sucesso", async () => {
    toggleLlmField.mockResolvedValue({
      status: "saved",
      snapshot: { fields: [], version: "0.2.0", revision: 1 },
    });
    const user = userEvent.setup();
    render(<ModelConfigCard {...baseProps} />);

    await user.click(ambiguitiesSwitch());

    await waitFor(() =>
      expect(toggleLlmField).toHaveBeenCalledWith(
        "p1",
        LLM_AMBIGUITIES_FIELD,
        true,
        { revision: 0 },
      ),
    );
    expect(toastSuccess).toHaveBeenCalledWith("Campo de ambiguidades adicionado");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("reverte o estado otimista e mostra erro quando a action falha", async () => {
    toggleLlmField.mockResolvedValue({ status: "error", message: "schema bloqueado" });
    const user = userEvent.setup();
    render(<ModelConfigCard {...baseProps} />);

    const sw = ambiguitiesSwitch();
    expect(sw.getAttribute("aria-checked")).toBe("false");

    await user.click(sw);

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("schema bloqueado"),
    );
    // useOptimistic reverte para a base (pydanticFields sem o campo) ao fim da
    // transição, já que o schema não mudou.
    await waitFor(() =>
      expect(ambiguitiesSwitch().getAttribute("aria-checked")).toBe("false"),
    );
  });

  it("reflete o schema quando o campo já existe", () => {
    render(
      <ModelConfigCard
        {...baseProps}
        pydanticFields={[{ name: "llm_ambiguidades" }]}
      />,
    );
    expect(ambiguitiesSwitch().getAttribute("aria-checked")).toBe("true");
  });
});

// Modelo que aceita temperatura e nível de raciocínio, para os campos
// renderizarem. Os kwargs vêm vazios de propósito: é o estado de um projeto
// que ainda não passou pela higienização de saveLlmConfig.
const geminiProps = {
  ...baseProps,
  config: {
    llm_provider: "google_genai" as const,
    llm_model: "gemini-3.8-flash",
    llm_kwargs: {} as Record<string, unknown>,
  },
};

/** Aplica o último updater passado a setConfig sobre `config`. */
function ultimaConfig(config: typeof geminiProps.config) {
  const updater = baseProps.setConfig.mock.calls.at(-1)?.[0] as
    | ((c: typeof config) => typeof config)
    | undefined;
  if (!updater) throw new Error("setConfig não foi chamado");
  return updater(config);
}

describe("ModelConfigCard — defaults quando o kwarg falta", () => {
  it("mostra a temperatura vazia, com o placeholder do provedor, em vez de 1.0", () => {
    // Exibir 1.0 com a chave ausente mentiria sobre o que a run manda: sem a
    // chave, o provider aplica o default dele.
    render(<ModelConfigCard {...geminiProps} />);
    const input = screen.getByLabelText("Temperatura") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("padrão do provedor");
  });

  it("apagar a temperatura remove a chave em vez de deixar o valor antigo", async () => {
    // Sem a remoção, o coordenador não tem como voltar a "sem temperatura":
    // o último número digitado ficaria gravado.
    const user = userEvent.setup();
    const config = {
      ...geminiProps.config,
      llm_kwargs: { temperature: 0.7, thinking_level: "high" },
    };
    render(<ModelConfigCard {...geminiProps} config={config} />);
    await user.clear(screen.getByLabelText("Temperatura"));
    const depois = ultimaConfig(config);
    expect(depois.llm_kwargs).not.toHaveProperty("temperature");
    expect(depois.llm_kwargs.thinking_level).toBe("high");
  });

  it("exibe o nível de raciocínio default e as justificativas ligadas", () => {
    // Os dois precisam coincidir com o que buildKwargsForCapabilities grava ao
    // salvar; quando o Switch mostrava desligado com a chave ausente, a run
    // saía com justificativas que a tela dizia não pedir.
    render(<ModelConfigCard {...geminiProps} />);
    expect(screen.getByText("Alto")).toBeTruthy();
    expect(screen.getAllByRole("switch")[0].getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("mantém as justificativas desligadas quando o projeto escolheu false", () => {
    render(
      <ModelConfigCard
        {...geminiProps}
        config={{ ...geminiProps.config, llm_kwargs: { include_justifications: false } }}
      />,
    );
    expect(screen.getAllByRole("switch")[0].getAttribute("aria-checked")).toBe(
      "false",
    );
  });
});
