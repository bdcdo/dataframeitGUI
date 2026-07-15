// @vitest-environment jsdom
import type { ChangeEvent, ReactNode } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  updateProject: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@/actions/projects", () => ({
  createProject: mocks.createProject,
  updateProject: mocks.updateProject,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// O Radix Select depende de geometria/portals ausentes no jsdom. Este mock
// preserva value, onValueChange, opções e disabled — exatamente o contrato de
// UI exercitado nestes testes — por meio de um <select> nativo.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: ReactNode;
  }) => (
    <select
      value={value}
      onChange={(event: ChangeEvent<HTMLSelectElement>) =>
        onValueChange(event.target.value)
      }
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({
    value,
    disabled,
    children,
  }: {
    value: string;
    disabled?: boolean;
    children: ReactNode;
  }) => (
    <option value={value} disabled={disabled}>
      {children}
    </option>
  ),
}));

import NewProjectPage from "@/app/(app)/projects/new/page";
import { RulesForm } from "@/app/(app)/projects/[id]/config/rules/RulesForm";

const originalFlag = process.env.NEXT_PUBLIC_LLM_ENABLED;
const rulesProps = {
  projectId: "p1",
  resolutionRule: "majority",
  minResponses: 2,
  allowResearcherReview: false,
  comparisonIncludesLlm: false,
  outOfScopeEnabled: true,
} as const;

beforeEach(() => {
  process.env.NEXT_PUBLIC_LLM_ENABLED = "false";
  mocks.createProject.mockReset();
  mocks.updateProject.mockReset();
  mocks.updateProject.mockResolvedValue({});
  mocks.refresh.mockReset();
});

afterEach(() => {
  cleanup();
  if (originalFlag === undefined) {
    delete process.env.NEXT_PUBLIC_LLM_ENABLED;
  } else {
    process.env.NEXT_PUBLIC_LLM_ENABLED = originalFlag;
  }
});

async function saveRules(): Promise<Record<string, unknown>> {
  fireEvent.click(screen.getByRole("button", { name: "Salvar Regras" }));
  await waitFor(() => expect(mocks.updateProject).toHaveBeenCalledOnce());
  return mocks.updateProject.mock.calls[0][1] as Record<string, unknown>;
}

describe("criação de projeto sem LLM", () => {
  it("semeia none e oferece somente none/compare_humans", () => {
    const { container } = render(<NewProjectPage />);

    const hidden = container.querySelector<HTMLInputElement>(
      'input[name="automation_mode"]',
    );
    expect(hidden?.value).toBe("none");
    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["Nenhuma automação", "Comparação humano-vs-humano"]);
  });
});

describe("Configurações › Regras sem LLM", () => {
  it("oferece somente os dois modos sem LLM para um projeto normal", () => {
    render(<RulesForm {...rulesProps} automationMode="compare_humans" />);

    const modeSelect = screen.getAllByRole("combobox")[0];
    expect(
      Array.from(modeSelect.querySelectorAll("option"), (option) =>
        option.textContent,
      ),
    ).toEqual(["Nenhuma automação", "Comparação humano-vs-humano"]);
    expect(
      screen.queryByRole("switch", {
        name: "Incluir o LLM no disparo da comparação",
      }),
    ).toBeNull();
  });

  it("exibe modo LLM existente como histórico desabilitado e não o regrava", async () => {
    render(
      <RulesForm
        {...rulesProps}
        automationMode="auto_review_llm"
        comparisonIncludesLlm
      />,
    );

    const historical = screen.getByRole("option", {
      name: "Auto-revisão vs LLM (histórico)",
    }) as HTMLOptionElement;
    expect(historical.disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toMatch(
      /respostas e filas existentes continuarão disponíveis/i,
    );

    const payload = await saveRules();
    expect(payload).not.toHaveProperty("automation_mode");
    expect(payload).not.toHaveProperty("comparison_includes_llm");
  });

  it("permite substituir o modo histórico apenas por uma opção sem LLM", async () => {
    render(
      <RulesForm
        {...rulesProps}
        automationMode="compare_llm"
        comparisonIncludesLlm
      />,
    );

    fireEvent.change(screen.getAllByRole("combobox")[0], {
      target: { value: "none" },
    });
    const payload = await saveRules();
    expect(payload).toMatchObject({
      automation_mode: "none",
      comparison_includes_llm: false,
    });
  });

  it("mostra comparison_includes_llm=true apenas como histórico removível", async () => {
    render(
      <RulesForm
        {...rulesProps}
        automationMode="compare_humans"
        comparisonIncludesLlm
      />,
    );

    const historicalSwitch = screen.getByRole("switch", {
      name: "Incluir o LLM no disparo da comparação",
    });
    expect(historicalSwitch.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("alert").textContent).toMatch(/pode desligá-la/i);

    fireEvent.click(historicalSwitch);
    const payload = await saveRules();
    expect(payload).toMatchObject({ comparison_includes_llm: false });
  });
});
