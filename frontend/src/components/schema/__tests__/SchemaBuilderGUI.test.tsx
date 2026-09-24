// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SchemaBuilderGUI } from "../SchemaBuilderGUI";
import type { PydanticField } from "@/lib/types";

// Id determinístico POR NOME: o mesmo nome devolve sempre o mesmo campo, para
// `field("q1")` construído na asserção ser igual ao passado no render.
const fieldIds = new Map<string, string>();
function field(name: string): PydanticField {
  let id = fieldIds.get(name);
  if (!id) {
    id = `00000000-0000-4000-8000-0000000000${String(fieldIds.size + 1).padStart(2, "0")}`;
    fieldIds.set(name, id);
  }
  return { id, name, type: "text", options: null, description: name };
}

// O nome acessível do gatilho é o nome do campo colado aos badges
// ("q2Texto livreq2"); o do botão de remover é "Remover campo q2". Ancorar no
// início separa os dois — sem a âncora, /q2/ casa com ambos.
const cardTrigger = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`^${name}`) });

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

  // Com a identidade no `field.id` (#473), nome duplicado é estado transitório
  // legítimo do editor: toda tecla propaga e o aviso é derivado — quem barra a
  // duplicata é o save, não o input.
  it("propaga o rename que duplica outro campo e mostra o aviso", async () => {
    render(<ControlledBuilder initial={[field("q1"), field("q2")]} />);
    await userEvent.click(cardTrigger("q2"));
    const input = screen.getByPlaceholderText("nome_do_campo");

    await userEvent.clear(input);
    await userEvent.type(screen.getByPlaceholderText("nome_do_campo"), "q");
    await userEvent.type(screen.getByPlaceholderText("nome_do_campo"), "1");

    expect(screen.getByText("Já existe um campo com esse nome.")).toBeTruthy();
    expect(screen.getByTestId("field-names").textContent).toBe("q1,q1");

    // Seguir digitando sai do estado duplicado sem nada travado: o valor nunca
    // ficou preso no "último nome livre".
    await userEvent.type(screen.getByPlaceholderText("nome_do_campo"), "0");
    expect(screen.queryByText("Já existe um campo com esse nome.")).toBeNull();
    expect(screen.getByTestId("field-names").textContent).toBe("q1,q10");
  });
});

// A identidade do card é `field.id` (#473): keys, DnD e expansão seguem o id
// do próprio campo, não um surrogate posicional. Estes testes cobrem o que a
// identidade precisa sustentar.
describe("SchemaBuilderGUI — identidade do card", () => {
  const nomeDoCampo = () => screen.getByPlaceholderText("nome_do_campo");

  it("expande o campo recém-adicionado, não o da mesma posição", async () => {
    render(<ControlledBuilder initial={[field("q1")]} />);
    expect(screen.queryByPlaceholderText("nome_do_campo")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Adicionar campo" }));

    // O editor aberto é o do campo novo — addField precisa do id de forma
    // síncrona para conseguir apontar a expansão para ele.
    expect((nomeDoCampo() as HTMLInputElement).value).toBe("campo_1");
  });

  it("remover um campo acima não transfere a expansão para o vizinho", async () => {
    render(<ControlledBuilder initial={[field("q1"), field("q2")]} />);
    await userEvent.click(cardTrigger("q2"));
    expect((nomeDoCampo() as HTMLInputElement).value).toBe("q2");

    await userEvent.click(screen.getByRole("button", { name: "Remover campo q1" }));

    // q1 saiu; q2 desliza para a posição 0. A expansão segue o id de q2, então
    // o editor aberto continua sendo o dele — com ids posicionais crus, a
    // expansão pularia para o card errado ou sumiria.
    expect(screen.getByTestId("field-names").textContent).toBe("q2");
    expect((nomeDoCampo() as HTMLInputElement).value).toBe("q2");
  });

  it("editar o nome não recria o card nem perde o foco", async () => {
    render(<ControlledBuilder initial={[field("q1")]} />);
    await userEvent.click(cardTrigger("q1"));
    const input = nomeDoCampo();

    await userEvent.type(input, "_a");

    // Mesmo nó de input após o rename: se a key fosse `field.name`, o React
    // remontaria o card a cada tecla e o foco iria embora.
    expect(nomeDoCampo()).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(screen.getByTestId("field-names").textContent).toBe("q1_a");
  });
});
