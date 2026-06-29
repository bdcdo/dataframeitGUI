// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// AddNoteButton arrasta next/navigation + server actions; como aqui só
// importa renderizar um placeholder, mockamos o componente inteiro.
vi.mock("@/components/shared/AddNoteButton", () => ({
  AddNoteButton: () => <div data-testid="add-note" />,
}));

import { VerdictsList, type DocGroup } from "@/components/reviews/VerdictsList";
import type { VerdictItem } from "@/app/(app)/projects/[id]/reviews/my-verdicts/page";

function makeItem(overrides?: Partial<VerdictItem>): VerdictItem {
  return {
    reviewId: "r1",
    documentId: "d1",
    documentTitle: "Doc 1",
    fieldName: "campo",
    fieldDescription: "Descrição do campo",
    fieldType: "text",
    verdict: "nao",
    coordinatorComment: null,
    myAnswer: "sim",
    isCorrect: false,
    responseSnapshot: null,
    acknowledgmentStatus: "pending",
    acknowledgmentComment: null,
    ...overrides,
  };
}

function renderList(
  onAcknowledge: (
    reviewId: string,
    status: "accepted" | "questioned",
    comment?: string,
  ) => Promise<boolean>,
  item: VerdictItem = makeItem(),
) {
  const group: DocGroup = { docId: "d1", title: "Doc 1", items: [item] };
  return render(
    <VerdictsList
      group={group}
      fields={[]}
      fieldFilter="all"
      onFieldFilterChange={vi.fn()}
      projectId="p1"
      userName="João"
      isPending={false}
      onAcknowledge={onAcknowledge}
    />,
  );
}

const QUESTION_PLACEHOLDER = /qual a sua dúvida/i;

afterEach(cleanup);
beforeEach(() => {
  // jsdom não implementa scrollTo; o effect de scroll do VerdictsList o chama.
  Element.prototype.scrollTo = vi.fn();
});

describe("VerdictsList — input de dúvida", () => {
  it("envia a dúvida e limpa o input ao concluir com sucesso", async () => {
    const user = userEvent.setup();
    const onAcknowledge = vi.fn().mockResolvedValue(true);
    renderList(onAcknowledge);

    await user.click(screen.getByRole("button", { name: /comentar dúvida/i }));
    await user.type(
      screen.getByPlaceholderText(QUESTION_PLACEHOLDER),
      "minha dúvida",
    );
    await user.click(screen.getByRole("button", { name: /^enviar$/i }));

    expect(onAcknowledge).toHaveBeenCalledWith("r1", "questioned", "minha dúvida");
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(QUESTION_PLACEHOLDER)).toBeNull(),
    );
  });

  it("fecha o input de dúvida aberto ao aceitar a correção (handleAck limpa em qualquer sucesso)", async () => {
    const user = userEvent.setup();
    const onAcknowledge = vi.fn().mockResolvedValue(true);
    renderList(onAcknowledge);

    await user.click(screen.getByRole("button", { name: /comentar dúvida/i }));
    expect(screen.getByPlaceholderText(QUESTION_PLACEHOLDER)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /aceitar correção/i }));

    expect(onAcknowledge).toHaveBeenCalledWith("r1", "accepted", undefined);
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(QUESTION_PLACEHOLDER)).toBeNull(),
    );
  });

  it("mantém o input e o texto quando o acknowledge falha", async () => {
    const user = userEvent.setup();
    const onAcknowledge = vi.fn().mockResolvedValue(false);
    renderList(onAcknowledge);

    await user.click(screen.getByRole("button", { name: /comentar dúvida/i }));
    await user.type(screen.getByPlaceholderText(QUESTION_PLACEHOLDER), "texto");
    await user.click(screen.getByRole("button", { name: /^enviar$/i }));

    await waitFor(() => expect(onAcknowledge).toHaveBeenCalled());
    const input = screen.getByPlaceholderText(
      QUESTION_PLACEHOLDER,
    ) as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe("texto");
  });
});
