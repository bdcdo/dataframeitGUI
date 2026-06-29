// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AnswerCard } from "@/components/compare/AnswerCard";
import { TooltipProvider } from "@/components/ui/tooltip";

afterEach(cleanup);

function renderCard(props: Partial<Parameters<typeof AnswerCard>[0]> = {}) {
  const onVote = vi.fn();
  render(
    <TooltipProvider>
      <AnswerCard
        index={0}
        displayAnswer="Deferido"
        respondentNames={["Ana"]}
        respondentCount={1}
        hasLlm={false}
        staleCount={0}
        isChosen={false}
        versions={["1.0.0"]}
        onVote={onVote}
        {...props}
      />
    </TooltipProvider>,
  );
  return { onVote };
}

describe("AnswerCard — overlay de voto", () => {
  it("vota ao clicar no card (overlay button) e ao acionar pelo teclado", async () => {
    const user = userEvent.setup();
    const { onVote } = renderCard();

    const voteButton = screen.getByRole("button", {
      name: /escolher esta resposta/i,
    });
    await user.click(voteButton);
    expect(onVote).toHaveBeenCalledTimes(1);

    voteButton.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onVote).toHaveBeenCalledTimes(3);
  });

  it("seleciona o gabarito sem disparar o voto (não há mais aninhamento)", async () => {
    const user = userEvent.setup();
    const onSetGabarito = vi.fn();
    const { onVote } = renderCard({
      equivalenceMode: {
        selected: true,
        onToggle: vi.fn(),
        gabarito: { isGabarito: false, onSetGabarito },
      },
    });

    await user.click(screen.getByRole("radio"));
    expect(onSetGabarito).toHaveBeenCalledTimes(1);
    expect(onVote).not.toHaveBeenCalled();
  });

  it("alterna a seleção pelo checkbox sem disparar o voto", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const { onVote } = renderCard({
      equivalenceMode: { selected: false, onToggle },
    });

    await user.click(screen.getByRole("checkbox"));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onVote).not.toHaveBeenCalled();
  });
});
