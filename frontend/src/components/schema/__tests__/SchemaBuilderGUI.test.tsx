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

  it("não constrói estado duplicado ao renomear", async () => {
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
