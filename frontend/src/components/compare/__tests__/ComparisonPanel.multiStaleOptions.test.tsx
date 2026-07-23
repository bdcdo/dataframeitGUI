// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/components/shared/AddNoteButton", () => ({
  AddNoteButton: () => <button type="button">Anotar</button>,
}));
vi.mock("@/components/stats/SuggestFieldDialog", () => ({
  SuggestFieldDialog: () => null,
}));

import { ComparisonPanel } from "@/components/compare/ComparisonPanel";
import type { PydanticField } from "@/lib/types";
import {
  panelProps,
  panelResponse as resp,
  type PanelResponse as Resp,
} from "./compare-test-helpers";

afterEach(cleanup);

// Campo cujas opções mudaram depois da codificação: "z" saiu do schema, mas a
// resposta de Ana ainda a tem marcada.
const FIELD: PydanticField = {
  name: "tags",
  type: "multi",
  options: ["x", "y"],
  description: "Tags",
} as PydanticField;

function renderPanel(responses: Resp[], onVerdict = vi.fn()) {
  render(
    <ComparisonPanel
      {...panelProps({
        fieldName: "tags",
        fieldDescription: "Tags",
        fieldType: "multi",
        fieldOptions: FIELD.options,
        fields: [FIELD],
        responses,
        onVerdict,
      })}
    />,
  );
  return onVerdict;
}

// `computeDivergentFieldNames` conta uma opção fora do schema atual como
// divergência (união schema + marcadas). Antes, a UI renderizava só as opções
// atuais: o revisor via tudo concordando e não tinha como resolver o campo, que
// voltava à fila para sempre — e `isAnswerCorrect`, que compara conjuntos,
// marcava a resposta que tinha a opção como incorreta em definitivo.
describe("ComparisonPanel — multi com opção fora das opções atuais (#484)", () => {
  it("renderiza a opção que saiu do schema, depois das atuais", () => {
    renderPanel([
      resp({ id: "ana", respondent_name: "Ana", answer: ["x", "z"] }),
      resp({ id: "bia", respondent_name: "Bia", answer: ["x"] }),
    ]);

    expect(screen.getByText("z")).toBeTruthy();
    // As do schema seguem presentes e na frente — o atalho numérico delas não
    // muda por causa de uma opção stale.
    expect(screen.getByText("x")).toBeTruthy();
    expect(screen.getByText("y")).toBeTruthy();
  });

  it("a opção stale entra no veredito com o pré-preenchimento de maioria", async () => {
    const user = userEvent.setup();
    const onVerdict = renderPanel([
      resp({ id: "ana", respondent_name: "Ana", answer: ["x", "z"] }),
      resp({ id: "bia", respondent_name: "Bia", answer: ["x"] }),
    ]);

    await user.click(screen.getByRole("button", { name: /Confirmar/i }));

    expect(onVerdict).toHaveBeenCalledTimes(1);
    const verdict = JSON.parse(onVerdict.mock.calls[0][0] as string);
    // "x" marcado por 2/2 vence pela maioria; "z" por 1/2 não atinge a maioria
    // estrita. O que importa é que "z" EXISTE no veredito — antes, a chave nem
    // era oferecida e o campo ficava travado.
    expect(verdict).toHaveProperty("z");
    expect(verdict.x).toBe(true);
    expect(verdict.z).toBe(false);
  });

  // O núcleo da issue não é o pré-preenchimento e sim a AGÊNCIA do revisor:
  // sem linha na tela ele não tinha como dizer que a opção fora do schema é a
  // correta. Marcar a checkbox e ver o `true` sair no veredito é o que prova
  // que a divergência ficou resolvível.
  it("o revisor consegue marcar a opção stale e ela sai true no veredito", async () => {
    const user = userEvent.setup();
    const onVerdict = renderPanel([
      resp({ id: "ana", respondent_name: "Ana", answer: ["x", "z"] }),
      resp({ id: "bia", respondent_name: "Bia", answer: ["x"] }),
    ]);

    await user.click(screen.getByText("z"));
    await user.click(screen.getByRole("button", { name: /Confirmar/i }));

    const verdict = JSON.parse(onVerdict.mock.calls[0][0] as string);
    expect(verdict.z).toBe(true);
    expect(verdict.x).toBe(true);
  });

  it("sem opção stale, o veredito tem exatamente as opções do schema", async () => {
    const user = userEvent.setup();
    const onVerdict = renderPanel([
      resp({ id: "ana", respondent_name: "Ana", answer: ["x"] }),
      resp({ id: "bia", respondent_name: "Bia", answer: ["x"] }),
    ]);
    expect(screen.queryByText("z")).toBeNull();

    await user.click(screen.getByRole("button", { name: /Confirmar/i }));

    const verdict = JSON.parse(onVerdict.mock.calls[0][0] as string);
    // Toda opção EXIBIDA tem chave no veredito, inclusive a que ninguém marcou
    // ("y"): `isAnswerCorrect` compara conjuntos, então chave faltando é a
    // mesma classe de bug em escala menor.
    expect(Object.keys(verdict).toSorted()).toEqual(["x", "y"]);
    expect(verdict.x).toBe(true);
    expect(verdict.y).toBe(false);
  });

  // Uma resposta stale (isFieldStale) segue exibida no painel, então as opções
  // que ela marcou também precisam de linha — o conjunto de entrada da união
  // aqui é deliberadamente mais amplo que o de `computeDivergentFieldNames`.
  it("opção marcada só por resposta stale também ganha linha", () => {
    renderPanel([
      resp({
        id: "ana",
        respondent_name: "Ana",
        answer: ["x", "w"],
        isFieldStale: true,
      }),
      resp({ id: "bia", respondent_name: "Bia", answer: ["x"] }),
    ]);
    expect(screen.getByText("w")).toBeTruthy();
  });
});
