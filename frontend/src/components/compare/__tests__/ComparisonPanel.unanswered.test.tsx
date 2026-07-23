// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

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

const FIELD: PydanticField = {
  name: "data_parecer",
  type: "date",
  description: "Data do parecer",
} as PydanticField;

function renderPanel(responses: Resp[], fieldHelpText?: string) {
  render(
    <ComparisonPanel
      {...panelProps({
        documentTitle: "Nota técnica 1",
        fieldName: "data_parecer",
        fieldDescription: "Data do parecer",
        fieldHelpText,
        fieldType: "date",
        fields: [FIELD],
        responses,
      })}
    />,
  );
}

describe("ComparisonPanel — não preencheu este campo (issue #247, ponto 3)", () => {
  it("lista o humano que deixou o campo em branco quando só o robô respondeu", () => {
    renderPanel([
      resp({ id: "llm", respondent_type: "llm", respondent_name: "Robô", answer: "2021-05-10" }),
      resp({ id: "ana", respondent_name: "Ana", answer: undefined }),
    ]);
    expect(screen.getByText(/1 respondente não preencheu este campo/i)).toBeTruthy();
    expect(screen.getByText(/Ana/)).toBeTruthy();
  });

  it("não conta respondente cujo schema antigo nem tinha o campo (isFieldStale)", () => {
    renderPanel([
      resp({ id: "llm", respondent_type: "llm", respondent_name: "Robô", answer: "2021-05-10" }),
      resp({ id: "bia", respondent_name: "Bia", answer: undefined, isFieldStale: true }),
    ]);
    expect(screen.queryByText(/não preencheu este campo/i)).toBeNull();
  });

  it("não lista LLM que deixou o campo em branco (a issue é sobre humanos)", () => {
    renderPanel([
      resp({ id: "robo", respondent_type: "llm", respondent_name: "Robô", answer: undefined }),
      resp({ id: "ana", respondent_name: "Ana", answer: "2021-05-10" }),
    ]);
    expect(screen.queryByText(/não preencheu este campo/i)).toBeNull();
  });

  it("deduplica o mesmo respondente com duas respostas em branco (respondent_id)", () => {
    renderPanel([
      resp({ id: "llm", respondent_type: "llm", respondent_name: "Robô", answer: "2021-05-10" }),
      resp({ id: "ana1", respondent_id: "ana", respondent_name: "Ana", answer: undefined }),
      resp({ id: "ana2", respondent_id: "ana", respondent_name: "Ana", answer: undefined }),
    ]);
    expect(screen.getByText(/1 respondente não preencheu este campo/i)).toBeTruthy();
    expect(screen.getByText(/: Ana$/)).toBeTruthy();
  });

  it("pluraliza quando dois ou mais deixaram em branco", () => {
    renderPanel([
      resp({ id: "llm", respondent_type: "llm", respondent_name: "Robô", answer: "2021-05-10" }),
      resp({ id: "ana", respondent_name: "Ana", answer: undefined }),
      resp({ id: "caio", respondent_name: "Caio", answer: undefined }),
    ]);
    expect(
      screen.getByText(/2 respondentes não preencheram este campo/i),
    ).toBeTruthy();
  });

  it("não mostra nada quando todos preencheram", () => {
    renderPanel([
      resp({ id: "llm", respondent_type: "llm", respondent_name: "Robô", answer: "2021-05-10" }),
      resp({ id: "ana", respondent_name: "Ana", answer: "2021-05-11" }),
    ]);
    expect(screen.queryByText(/não preencheu este campo/i)).toBeNull();
  });
});

describe("ComparisonPanel — help_text no header (#373)", () => {
  const RESPONSES = [
    resp({ id: "llm", respondent_type: "llm", respondent_name: "Robô", answer: "2021-05-10" }),
  ];

  it("mostra o help_text do campo quando presente", () => {
    renderPanel(RESPONSES, "Considere apenas a data de assinatura.");
    expect(
      screen.getByText("Considere apenas a data de assinatura."),
    ).toBeTruthy();
  });

  it("não renderiza bloco de help_text quando ausente", () => {
    renderPanel(RESPONSES);
    expect(screen.queryByText(/Considere apenas/)).toBeNull();
  });
});
