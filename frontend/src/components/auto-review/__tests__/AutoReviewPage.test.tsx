// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AutoReviewPage } from "../AutoReviewPage";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/hooks/usePinnedDoc", () => ({
  usePinnedDoc: () => [null, vi.fn()],
  pinnedDocIndex: () => 0,
}));

vi.mock("../AutoReviewEmptyState", () => ({
  AutoReviewEmptyState: ({ readOnly }: { readOnly: boolean }) => (
    <div data-testid="empty-state" data-read-only={String(readOnly)} />
  ),
}));

afterEach(cleanup);

function renderEmptyQueue(viewAsUserId: string, currentUserId: string) {
  render(
    <AutoReviewPage
      projectId="project-1"
      fields={[]}
      docs={[]}
      isCoordinator
      viewAsUserId={viewAsUserId}
      reviewers={[]}
      currentUserId={currentUserId}
    />,
  );
}

describe("AutoReviewPage — fila própria e viewAs", () => {
  it("mantém editável a fila canônica da própria conta-alias", () => {
    renderEmptyQueue("canonical-member", "canonical-member");
    expect(screen.getByTestId("empty-state").dataset.readOnly).toBe("false");
  });

  it("torna somente leitura a fila selecionada pelo viewAs do coordenador", () => {
    renderEmptyQueue("selected-member", "canonical-member");
    expect(screen.getByTestId("empty-state").dataset.readOnly).toBe("true");
  });
});
