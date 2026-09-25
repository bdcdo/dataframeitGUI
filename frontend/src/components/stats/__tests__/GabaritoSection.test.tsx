// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/actions/stats", () => ({ fetchGabaritoForComment: vi.fn() }));

import { GabaritoSection } from "@/components/stats/GabaritoSection";
import type { ReviewComment } from "@/components/stats/comment-card-utils";

afterEach(cleanup);

function comment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: "r1", documentId: "d1", documentTitle: "Doc", fieldName: "q", fieldDescription: "Pergunta",
    verdict: "Sim", comment: "nota", reviewerName: "ana", resolvedAt: null, createdAt: "2026-01-01T00:00:00Z",
    chosenResponseId: "resp1", source: "review",
    responseSnapshot: [{ id: "resp1", respondent_name: "Ana", respondent_type: "humano", answer: "Sim" }],
    ...overrides,
  };
}

describe("GabaritoSection (#758)", () => {
  it.each([
    [false, "Gabarito:"],
    [true, "Veredito anterior à mudança da pergunta:"],
  ])("verdictStale=%s mostra %s", async (verdictStale, label) => {
    render(<GabaritoSection comment={comment({ verdictStale })} projectId="p1" />);
    await userEvent.click(screen.getByRole("button", { name: /Ver gabarito/ }));
    expect(await screen.findByText(label)).toBeTruthy();
  });
});
