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

afterEach(cleanup);

// Campo cujas opções mudaram depois da codificação: "z" saiu do schema, mas a
// resposta de Ana ainda a tem marcada.
const FIELD: PydanticField = {
  name: "tags",
  type: "multi",
  options: ["x", "y"],
  description: "Tags",
} as PydanticField;

type Resp = Parameters<typeof ComparisonPanel>[0]["responses"][number];

function resp(over: Partial<Resp> & { id: string }): Resp {
  return {
    respondent_type: "humano",
    respondent_name: "Anon",
    respondent_id: null,
    answer: undefined,
    is_latest: true,
    isFieldStale: false,
    ...over,
  } as Resp;
}

function renderPanel(responses: Resp[], onVerdict = vi.fn()) {
  render(
    <ComparisonPanel
      readOnly={false}
      projectId="p1"
      documentId="d1"
      documentTitle="Doc 1"
      fieldName="tags"
      fieldDescription="Tags"
      fieldType="multi"
      fieldOptions={FIELD.options}
      fields={[FIELD]}
      fieldIndex={0}
      totalFields={1}
      responses={responses}
      existingVerdict={null}
      reviewed={[false]}
      isDivergent={true}
      docStatus={{ complete: false }}
      onFieldNavigate={vi.fn()}
      onVerdict={onVerdict}
      pendingVerdict={null}
      onPrepareVerdict={vi.fn()}
      onConfirmPendingVerdict={vi.fn()}
      onDiscardPendingVerdict={vi.fn()}
      isSavingVerdict={false}
      onMarkReviewed={vi.fn()}
      comment=""
      onCommentChange={vi.fn()}
      commentCount={0}
      suggestionCount={0}
      equivalence={{ allow: false, canManageAnyPair: false }}
      equivalences={[]}
      onConfirmEquivalent={vi.fn(async () => {})}
      onUnmarkEquivalencePair={vi.fn(async () => {})}
      currentUserId="u1"
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

  it("a opção stale entra no veredito e é resolvível pelo revisor", async () => {
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

  it("sem opção stale, o veredito só tem as opções do schema", () => {
    const onVerdict = renderPanel([
      resp({ id: "ana", respondent_name: "Ana", answer: ["x"] }),
      resp({ id: "bia", respondent_name: "Bia", answer: ["x"] }),
    ]);
    expect(screen.queryByText("z")).toBeNull();
    expect(onVerdict).not.toHaveBeenCalled();
  });
});
