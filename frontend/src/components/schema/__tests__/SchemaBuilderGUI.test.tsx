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

  // Limitação conhecida, não comportamento desejado: o rename para um nome já
  // existente é recusado para preservar a unicidade que `mergeSchemas` exige, e
  // o efeito colateral é que o valor trava no último nome livre digitado ("q").
  // O teste fixa o contrato atual para que a issue #473 (id estável no campo)
  // tenha um ponto de partida explícito ao removê-lo.
  it("recusa o rename que duplicaria outro campo (ver #473)", async () => {
    render(<ControlledBuilder initial={[field("q1"), field("q2")]} />);
    await userEvent.click(cardTrigger("q2"));
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

// O card não tem identidade de domínio (`name` é conteúdo editável), então a
// expansão é rastreada por um id surrogate de `useStableListIds`. Estes testes
// cobrem o que o id precisa sustentar; sem eles, trocar a fonte dos ids não
// tinha rede nenhuma.
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
