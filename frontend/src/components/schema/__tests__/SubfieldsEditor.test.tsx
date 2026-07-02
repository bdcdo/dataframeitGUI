// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { useState } from "react";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  SubfieldsEditor,
  type SubfieldsPatch,
} from "@/components/schema/SubfieldsEditor";
import type { SubfieldDef } from "@/lib/types";

afterEach(cleanup);

// Wrapper controlado no estilo do FieldCard: aplica o patch sobre um "field"
// local, reproduzindo o fluxo real onChange -> re-render com props novas.
function ControlledEditor({
  initialSubfields,
  initialRule,
  initialOptions = [],
  onPatch,
}: {
  initialSubfields?: SubfieldDef[];
  initialRule?: "all" | "at_least_one";
  initialOptions?: string[];
  onPatch?: (patch: SubfieldsPatch) => void;
}) {
  const [state, setState] = useState<{
    subfields: SubfieldDef[] | undefined;
    subfieldRule: "all" | "at_least_one" | undefined;
    options: string[];
  }>({
    subfields: initialSubfields,
    subfieldRule: initialRule,
    options: initialOptions,
  });
  return (
    <SubfieldsEditor
      subfields={state.subfields}
      subfieldRule={state.subfieldRule}
      options={state.options}
      onChange={(patch) => {
        onPatch?.(patch);
        setState((prev) => ({
          subfields: "subfields" in patch ? patch.subfields : prev.subfields,
          subfieldRule:
            "subfield_rule" in patch ? patch.subfield_rule : prev.subfieldRule,
          options: "options" in patch ? (patch.options ?? []) : prev.options,
        }));
      }}
    />
  );
}

const sf = (key: string, label: string, required = true): SubfieldDef => ({
  key,
  label,
  required,
});

function keyInputs() {
  return screen
    .getAllByPlaceholderText("chave") as HTMLInputElement[];
}

describe("SubfieldsEditor — toggle", () => {
  it("ligar emite subfields default + rule 'all' + options null", async () => {
    const user = userEvent.setup();
    const onPatch = vi.fn();
    render(<ControlledEditor onPatch={onPatch} />);

    await user.click(screen.getByRole("switch"));

    expect(onPatch).toHaveBeenCalledWith({
      subfields: [
        { key: "campo_1", label: "Campo 1", required: true },
        { key: "campo_2", label: "Campo 2", required: true },
      ],
      subfield_rule: "all",
      options: null,
    });
    await waitFor(() => expect(keyInputs()).toHaveLength(2));
  });

  it("desligar emite subfields/subfield_rule undefined", async () => {
    const user = userEvent.setup();
    const onPatch = vi.fn();
    render(
      <ControlledEditor
        initialSubfields={[sf("a", "A")]}
        initialRule="all"
        onPatch={onPatch}
      />,
    );

    // O primeiro switch é o toggle "Dividir em subcampos".
    await user.click(screen.getAllByRole("switch")[0]);

    expect(onPatch).toHaveBeenCalledWith({
      subfields: undefined,
      subfield_rule: undefined,
    });
    // Sem subcampos, o modo "Respostas padronizadas" aparece.
    await waitFor(() =>
      expect(screen.getByText(/respostas padronizadas/i)).toBeTruthy(),
    );
  });
});

describe("SubfieldsEditor — lista de subcampos (keys estáveis)", () => {
  it("remover o primeiro subcampo preserva o nó DOM do segundo", async () => {
    const user = userEvent.setup();
    render(
      <ControlledEditor
        initialSubfields={[sf("a", "A"), sf("b", "B")]}
        initialRule="all"
      />,
    );

    const bNodeBefore = keyInputs()[1];
    expect(bNodeBefore.value).toBe("b");

    // Cada linha de subcampo termina num botão de lixeira (ghost com svg);
    // o botão de remover da primeira linha é o primeiro deles.
    const removeButtons = screen
      .getAllByRole("button")
      .filter((b) => b.querySelector("svg"));
    await user.click(removeButtons[0]);

    await waitFor(() => {
      expect(keyInputs().map((i) => i.value)).toEqual(["b"]);
    });
    expect(keyInputs()[0]).toBe(bNodeBefore);
  });

  it("remover o último subcampo desliga o modo (rule undefined)", async () => {
    const user = userEvent.setup();
    const onPatch = vi.fn();
    render(
      <ControlledEditor
        initialSubfields={[sf("a", "A")]}
        initialRule="all"
        onPatch={onPatch}
      />,
    );

    const removeButtons = screen
      .getAllByRole("button")
      .filter((b) => b.querySelector("svg"));
    await user.click(removeButtons[0]);

    expect(onPatch).toHaveBeenCalledWith({
      subfields: undefined,
      subfield_rule: undefined,
    });
  });

  it("adicionar subcampo emite a lista com campo_N default", async () => {
    const user = userEvent.setup();
    const onPatch = vi.fn();
    render(
      <ControlledEditor
        initialSubfields={[sf("a", "A")]}
        initialRule="all"
        onPatch={onPatch}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /adicionar subcampo/i }),
    );

    expect(onPatch).toHaveBeenCalledWith({
      subfields: [sf("a", "A"), sf("campo_2", "Campo 2")],
    });
    await waitFor(() => expect(keyInputs()).toHaveLength(2));
  });

  it("digitar na chave sanitiza para snake_case e não perde o foco", async () => {
    const user = userEvent.setup();
    render(
      <ControlledEditor
        initialSubfields={[sf("", "A")]}
        initialRule="all"
      />,
    );

    const input = keyInputs()[0];
    await user.click(input);
    await user.keyboard("Ab 1");

    await waitFor(() => expect(keyInputs()[0].value).toBe("ab1"));
    expect(document.activeElement).toBe(keyInputs()[0]);
  });
});

describe("SubfieldsEditor — regra", () => {
  it("trocar para 'Pelo menos um' emite o patch e esconde o switch Obrig.", async () => {
    const user = userEvent.setup();
    const onPatch = vi.fn();
    render(
      <ControlledEditor
        initialSubfields={[sf("a", "A")]}
        initialRule="all"
        onPatch={onPatch}
      />,
    );

    // Com rule "all", cada linha tem switch de obrigatoriedade (além do toggle).
    expect(screen.getAllByRole("switch")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: /pelo menos um/i }));

    expect(onPatch).toHaveBeenCalledWith({ subfield_rule: "at_least_one" });
    await waitFor(() =>
      // Só resta o toggle "Dividir em subcampos".
      expect(screen.getAllByRole("switch")).toHaveLength(1),
    );
  });
});

describe("SubfieldsEditor — respostas padronizadas", () => {
  it("esvaziar as opções emite options: null", async () => {
    const user = userEvent.setup();
    const onPatch = vi.fn();
    render(
      <ControlledEditor initialOptions={["Sim"]} onPatch={onPatch} />,
    );

    const removeButtons = screen
      .getAllByRole("button")
      .filter((b) => b.querySelector("svg"));
    await user.click(removeButtons[0]);

    await waitFor(() =>
      expect(onPatch).toHaveBeenCalledWith({ options: null }),
    );
  });
});
