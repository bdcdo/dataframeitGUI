// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { warmUpJsdom } from "@/test-utils/jsdom-warm-up";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { ReactElement } from "react";
import { DocPager } from "@/components/shared/DocPager";
import { FullscreenNav } from "@/components/coding/FullscreenNav";
import { SplitViewNavBar } from "@/components/stats/SplitViewNavBar";
import { VerdictsHeader } from "@/components/reviews/VerdictsHeader";

// Exigido pela regra test-jsdom-warm-up (eslint-rules/test-jsdom-warm-up.mjs).
beforeAll(() => warmUpJsdom(), 30_000);

afterEach(cleanup);

const previous = () => screen.getByTitle("Documento anterior") as HTMLButtonElement;
const next = () => screen.getByTitle("Próximo documento") as HTMLButtonElement;

describe("DocPager", () => {
  it("mostra a posição 1-based e navega por índice", () => {
    const onNavigate = vi.fn();
    render(<DocPager index={2} total={5} onNavigate={onNavigate} />);
    expect(screen.getByText("3/5")).toBeTruthy();
    fireEvent.click(previous());
    fireEvent.click(next());
    expect(onNavigate.mock.calls).toEqual([[1], [3]]);
  });

  it("desabilita anterior no primeiro e próximo no último", () => {
    const { rerender } = render(
      <DocPager index={0} total={2} onNavigate={vi.fn()} />,
    );
    expect(previous().disabled).toBe(true);
    expect(next().disabled).toBe(false);
    rerender(<DocPager index={1} total={2} onNavigate={vi.fn()} />);
    expect(previous().disabled).toBe(false);
    expect(next().disabled).toBe(true);
  });
});

// Os cabeçalhos que tinham paginador próprio passam pelo DocPager: o mesmo
// contrato (índice zero-based, onNavigate com o índice de destino, limites
// desabilitados) vale em todos.
const headers: Array<[string, (onNavigate: (i: number) => void) => ReactElement]> = [
  [
    "FullscreenNav",
    (onNavigate) => (
      <FullscreenNav
        title="Doc"
        currentIndex={1}
        total={3}
        onNavigate={onNavigate}
        onExit={vi.fn()}
      />
    ),
  ],
  [
    "SplitViewNavBar",
    (onNavigate) => (
      <SplitViewNavBar
        title="Doc"
        onBack={vi.fn()}
        docIndex={1}
        docCount={3}
        onNavigate={onNavigate}
      />
    ),
  ],
  [
    "VerdictsHeader",
    (onNavigate) => (
      <VerdictsHeader
        searchQuery=""
        onSearchChange={vi.fn()}
        filter="all"
        onFilterChange={vi.fn()}
        totals={{ items: 3, incorrect: 0, pending: 0, questioned: 0 }}
        respondents={[]}
        onSelectRespondent={vi.fn()}
        isPending={false}
        docCount={3}
        docIndex={1}
        onNavigate={onNavigate}
      />
    ),
  ],
];

describe.each(headers)("%s usa o DocPager", (_name, renderHeader) => {
  it("navega para o índice vizinho e mostra i/n", () => {
    const onNavigate = vi.fn();
    render(renderHeader(onNavigate));
    expect(screen.getByText("2/3")).toBeTruthy();
    fireEvent.click(previous());
    fireEvent.click(next());
    expect(onNavigate.mock.calls).toEqual([[0], [2]]);
    expect(previous().className).toContain("size-7");
  });
});
