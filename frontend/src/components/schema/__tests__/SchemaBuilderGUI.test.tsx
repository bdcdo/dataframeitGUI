// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SchemaBuilderGUI } from "../SchemaBuilderGUI";
import type { PydanticField } from "@/lib/types";

function field(name: string): PydanticField {
  return { name, type: "text", options: null, description: name };
}

function ControlledBuilder({ initial }: { initial: PydanticField[] }) {
  const [fields, setFields] = useState(initial);
  return (
    <>
      <SchemaBuilderGUI fields={fields} onChange={setFields} />
      <output data-testid="field-names">{fields.map(({ name }) => name).join(",")}</output>
    </>
  );
}

afterEach(cleanup);

describe("SchemaBuilderGUI — nomes únicos", () => {
  it("usa o primeiro nome campo_N livre ao adicionar", async () => {
    const onChange = vi.fn();
    render(
      <SchemaBuilderGUI
        fields={[field("campo_1"), field("campo_3")]}
        onChange={onChange}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Adicionar campo" }));

    expect(onChange).toHaveBeenCalledWith([
      field("campo_1"),
      field("campo_3"),
      expect.objectContaining({ name: "campo_2" }),
    ]);
  });

  // Limitação conhecida, não comportamento desejado: o rename para um nome já
  // existente é recusado para preservar a unicidade que `mergeSchemas` exige, e
  // o efeito colateral é que o valor trava no último nome livre digitado ("q").
  // O teste fixa o contrato atual para que a issue #473 (id estável no campo)
  // tenha um ponto de partida explícito ao removê-lo.
  it("recusa o rename que duplicaria outro campo (ver #473)", async () => {
    render(<ControlledBuilder initial={[field("q1"), field("q2")]} />);
    await userEvent.click(screen.getByRole("button", { name: /q2/i }));
    const input = screen.getByPlaceholderText("nome_do_campo");

    await userEvent.clear(input);
    await userEvent.type(screen.getByPlaceholderText("nome_do_campo"), "q");
    await userEvent.type(screen.getByPlaceholderText("nome_do_campo"), "1");

    expect(screen.getByText("Já existe um campo com esse nome.")).toBeTruthy();
    expect(screen.getByTestId("field-names").textContent).toBe("q1,q");
    const names = screen.getByTestId("field-names").textContent!.split(",");
    expect(new Set(names).size).toBe(names.length);
  });
});
