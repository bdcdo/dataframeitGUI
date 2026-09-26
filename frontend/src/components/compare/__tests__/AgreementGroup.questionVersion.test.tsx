// @vitest-environment jsdom
//
// O "=" só funde respostas dadas à versão atual da pergunta: a RPC recusa o
// par com resposta de outra versão (`record_response_equivalences`), então o
// card que só tem respostas assim não oferece o "=", com a razão à vista, e a
// fusão escolhe como representante do grupo uma resposta da versão atual.
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AgreementGroup } from "@/components/compare/AgreementGroup";
import { ComparisonPanel } from "@/components/compare/ComparisonPanel";
import { stubRadixJsdomApis } from "@/test-utils/radix-jsdom";
import { panelProps, panelResponse } from "./compare-test-helpers";

vi.mock("@/components/shared/AddNoteButton", () => ({
  AddNoteButton: () => <button type="button">Anotar</button>,
}));
vi.mock("@/components/stats/SuggestFieldDialog", () => ({
  SuggestFieldDialog: () => null,
}));

beforeAll(stubRadixJsdomApis);
afterEach(cleanup);

type Resp = Parameters<typeof AgreementGroup>[0]["responses"][number];

function resp(over: Partial<Resp> & { id: string; answer: unknown }): Resp {
  return {
    respondent_type: "humano",
    respondent_name: over.id,
    is_latest: true,
    isFieldStale: false,
    answersCurrentQuestion: true,
    ...over,
  } as Resp;
}

function renderGroup(responses: Resp[]) {
  const onConfirmEquivalent = vi.fn<
    (responseIds: string[], gabaritoId: string, verdictDisplay: string) => Promise<void>
  >(async () => {});
  render(
    <AgreementGroup
      readOnly={false}
      responses={responses}
      existingVerdict={null}
      pendingVerdict={null}
      onVote={vi.fn()}
      domainField={null}
      allowEquivalence={true}
      equivalences={[]}
      onConfirmEquivalent={onConfirmEquivalent}
      onUnmarkPair={vi.fn(async () => {})}
      currentUserId="u1"
      canManageAnyPair={false}
      pendingConfirm={{ onConfirm: vi.fn(), onDiscard: vi.fn(), isSaving: false }}
    />,
  );
  return { onConfirmEquivalent };
}

function cardOf(answer: string): HTMLElement {
  return screen.getAllByTestId("answer-card").find((card) => within(card).queryByText(answer))!;
}

const REASON = /"=" indisponível/i;

describe("AgreementGroup: \"=\" e versão da pergunta", () => {
  it("card só com resposta de outra versão não oferece o \"=\" e mostra a razão", () => {
    renderGroup([
      resp({ id: "ana", answer: "NI" }),
      resp({ id: "bia", answer: "N/A", answersCurrentQuestion: false }),
    ]);
    const stale = cardOf("N/A");
    expect(within(stale).getByText(REASON)).toBeTruthy();
    expect(within(stale).getByRole("checkbox").hasAttribute("disabled")).toBe(true);
    const current = cardOf("NI");
    expect(within(current).queryByText(REASON)).toBeNull();
    expect(within(current).getByRole("checkbox").hasAttribute("disabled")).toBe(false);
  });

  it("\"Todas são similares\" deixa de fora o card de outra versão e funde com representante da versão atual", async () => {
    const user = userEvent.setup();
    const { onConfirmEquivalent } = renderGroup([
      // O grupo NI tem uma resposta de outra versão ANTES da atual.
      resp({ id: "velha", answer: "NI", answersCurrentQuestion: false }),
      resp({ id: "ana", answer: "NI" }),
      resp({ id: "bia", answer: "N/A", answersCurrentQuestion: false }),
      resp({ id: "caio", answer: "não informado" }),
    ]);

    await user.click(screen.getByRole("button", { name: /todas são similares/i }));
    // Os dois cards com resposta da versão atual (NI com 2 respostas, "não
    // informado" com 1); o de "N/A" não entra na seleção.
    await user.click(await screen.findByRole("button", { name: /confirmar 3 respostas como equivalentes/i }));

    await waitFor(() => expect(onConfirmEquivalent).toHaveBeenCalledTimes(1));
    const [responseIds, gabaritoId] = onConfirmEquivalent.mock.calls[0];
    expect(responseIds.toSorted()).toEqual(["ana", "caio"]);
    expect(gabaritoId).toBe("ana");
  });
});

describe("ComparisonPanel: o card recebe a versão da pergunta de cada resposta", () => {
  it("mostra a razão no card de resposta de outra versão", () => {
    render(
      <ComparisonPanel
        {...panelProps({
          equivalence: { allow: true, canManageAnyPair: false },
          responses: [
            panelResponse({ id: "ana", answer: "NI", answersCurrentQuestion: true }),
            panelResponse({ id: "bia", answer: "N/A", answersCurrentQuestion: false }),
          ],
        })}
      />,
    );
    expect(within(cardOf("N/A")).getByText(REASON)).toBeTruthy();
    expect(within(cardOf("NI")).queryByText(REASON)).toBeNull();
  });
});
