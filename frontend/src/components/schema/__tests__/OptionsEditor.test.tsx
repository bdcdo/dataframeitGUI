// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { OptionsEditor } from "@/components/schema/OptionsEditor";

afterEach(cleanup);

// Wrapper controlado: o OptionsEditor é controlado (options vêm do pai), então
// o teste precisa segurar o estado para reproduzir o fluxo real de edição.
function ControlledEditor({ initial }: { initial: string[] }) {
  const [options, setOptions] = useState(initial);
  return <OptionsEditor options={options} onChange={setOptions} />;
}

function inputs() {
  return screen.getAllByRole("textbox") as HTMLInputElement[];
}

describe("OptionsEditor — keys estáveis (no-array-index-as-key)", () => {
  it("preserva a identidade do nó DOM ao remover uma opção do topo", async () => {
    const user = userEvent.setup();
    render(<ControlledEditor initial={["a", "b", "c"]} />);

    // Guarda a referência do nó do input "b" (índice 1). Foco/cursor/seleção
    // vivem nesse nó — preservá-lo é o que garante que não vazem ao remover.
    const bNodeBefore = inputs()[1];
    expect(bNodeBefore.value).toBe("b");

    // Remove a opção de índice 0 ("a"). Cada linha tem um botão X; o primeiro
    // botão com ícone é o X da primeira opção.
    const removeButtons = screen
      .getAllByRole("button")
      .filter((b) => b.querySelector("svg"));
    await user.click(removeButtons[0]);

    await waitFor(() => {
      expect(inputs().map((i) => i.value)).toEqual(["b", "c"]);
    });

    // Com key estável, o React MOVE o nó de "b" para a posição 0 (mesmo nó DOM).
    // Com key={i}, reaproveitaria o nó da posição e trocaria o value → nó
    // diferente, foco/cursor escorregando para a opção errada.
    expect(inputs()[0]).toBe(bNodeBefore);
  });

  it("adicionar opção foca o novo input vazio no fim", async () => {
    const user = userEvent.setup();
    render(<ControlledEditor initial={["x"]} />);

    await user.click(screen.getByRole("button", { name: /adicionar opção/i }));

    await waitFor(() => expect(inputs()).toHaveLength(2));
    const last = inputs()[1];
    expect(last.value).toBe("");
    expect(document.activeElement).toBe(last);
  });
});
