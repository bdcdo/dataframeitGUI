// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AutoReviewPage } from "../AutoReviewPage";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/hooks/usePinnedDoc", () => ({
  usePinnedDocNavigation: () => ({
    docIndex: 0,
    navigateToIndex: vi.fn(),
  }),
}));

vi.mock("../AutoReviewEmptyState", () => ({
  AutoReviewEmptyState: ({ readOnly }: { readOnly: boolean }) => (
    <div data-testid="empty-state" data-read-only={String(readOnly)} />
  ),
}));

afterEach(cleanup);

function renderEmptyQueue(queueUserId: string, ownQueueUserId: string) {
  render(
    <AutoReviewPage
      projectId="project-1"
      fields={[]}
      docs={[]}
      isCoordinator
      queueUserId={queueUserId}
      reviewers={[]}
      ownQueueUserId={ownQueueUserId}
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
