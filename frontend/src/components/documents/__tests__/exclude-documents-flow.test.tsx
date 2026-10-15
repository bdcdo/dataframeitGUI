// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, beforeAll } from "vitest";
import { warmUpJsdom } from "@/test-utils/jsdom-warm-up";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DocumentSummary } from "@/components/documents/DocumentList";

const mocks = vi.hoisted(() => ({
  excludeDocuments: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

// useDocumentActions importa as três actions; declarar só a exercida aqui
// quebraria o import do módulo.
vi.mock("@/actions/documents", () => ({
  excludeDocuments: mocks.excludeDocuments,
  restoreDocuments: vi.fn(),
  hardDeleteDocuments: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { ExcludeDocumentsDialog } from "@/components/documents/ExcludeDocumentsDialog";
import { useDocumentActions } from "@/components/documents/useDocumentActions";

const doc: DocumentSummary = {
  id: "doc-1",
  external_id: "0001",
  title: "Parecer 0001",
  responseCount: 2,
};

// Exercita o fluxo real do DocumentsPageClient — o hook de verdade ligado ao
// diálogo de verdade — em vez de reimplementar o estado no teste. É o que faz
// esta suíte responder pelo comportamento que o preventDefault mudou.
function Harness() {
  const {
    excludeTarget,
    excludeReason,
    setExcludeReason,
    isPending,
    requestExcludeSingle,
    closeExclude,
    confirmExclude,
  } = useDocumentActions("project-1", [doc]);

  return (
    <>
      <button onClick={() => requestExcludeSingle(doc)}>Excluir documento</button>
      <ExcludeDocumentsDialog
        target={excludeTarget}
        reason={excludeReason}
        onReasonChange={setExcludeReason}
        isPending={isPending}
        onConfirm={confirmExclude}
        onClose={closeExclude}
      />
    </>
  );
}

// O gatilho e o botão de confirmação não compartilham rótulo, mas escopar ao
// diálogo deixa explícito qual dos dois está sendo acionado. A busca espera, em
// vez de consultar uma vez: enquanto a exclusão pende, o mesmo botão se chama
// "Excluindo…", e o toast de erro é disparado de dentro da transição, antes do
// render que devolve `isPending` a false. Logo depois do `waitFor` do toast o
// botão ainda pode estar como "Excluindo…"; sem carga o React comita antes da
// consulta, mas com a CPU disputada o render atrasa e um `getByRole` síncrono
// falha.
async function findConfirmButton() {
  const dialog = await screen.findByRole("alertdialog");
  return within(dialog).findByRole("button", { name: "Excluir" });
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` zera as chamadas, mas não a fila de `mockResolvedValueOnce`.
  // Sem o reset, um teste que falha antes de consumir a fila deixa a resposta
  // seguinte para o próximo teste, e uma falha vira duas.
  mocks.excludeDocuments.mockReset();
  mocks.excludeDocuments.mockResolvedValue(undefined);
});

// O primeiro teste deste arquivo pagava o carregamento a frio de React DOM,
// Testing Library, user-event e Radix e estourava os 5 s com a suíte
// disputando a CPU (src/test-utils/jsdom-warm-up.tsx).
beforeAll(() => warmUpJsdom(), 30_000);

describe("ExcludeDocumentsDialog — fechamento sob controle do pai", () => {
  it("preserva o motivo digitado quando a exclusão falha e conclui no retry", async () => {
    mocks.excludeDocuments
      .mockResolvedValueOnce({ error: "Falha ao excluir" })
      .mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Excluir documento" }));
    await user.type(
      await screen.findByLabelText(/Motivo da exclusão/),
      "fora do escopo",
    );
    await user.click(await findConfirmButton());

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith("Falha ao excluir"),
    );
    // O diálogo permanece em cena com o texto intacto: fechar aqui obrigaria o
    // coordenador a reabrir e redigitar o motivo que a action exige.
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(
      screen.getByLabelText<HTMLTextAreaElement>(/Motivo da exclusão/).value,
    ).toBe("fora do escopo");
    expect(mocks.toastSuccess).not.toHaveBeenCalled();

    const retryButton = await findConfirmButton();
    expect(retryButton.hasAttribute("disabled")).toBe(false);
    await user.click(retryButton);

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(mocks.excludeDocuments).toHaveBeenCalledTimes(2);
    expect(mocks.excludeDocuments).toHaveBeenLastCalledWith(
      "project-1",
      ["doc-1"],
      "fora do escopo",
    );
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
  });

  it("não deixa confirmar sem motivo, mantendo o diálogo utilizável", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Excluir documento" }));

    // O gate do motivo vive no `disabled` do botão, não no corpo do onConfirm:
    // a validação de confirmExclude é defesa em profundidade e não é alcançada
    // por esta via enquanto o botão estiver desabilitado.
    expect((await findConfirmButton()).hasAttribute("disabled")).toBe(true);
    expect(mocks.excludeDocuments).not.toHaveBeenCalled();

    await user.type(
      screen.getByLabelText(/Motivo da exclusão/),
      "duplicado",
    );

    expect((await findConfirmButton()).hasAttribute("disabled")).toBe(false);
  });
});
