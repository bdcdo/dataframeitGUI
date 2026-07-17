// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useReviewQueueNavigation } from "@/hooks/useReviewQueueNavigation";

beforeEach(() => sessionStorage.clear());
afterEach(cleanup);

describe("useReviewQueueNavigation", () => {
  const docs = [{ docId: "d1" }, { docId: "d2" }];

  it("restaura o pin e limita a navegação aos documentos válidos", () => {
    sessionStorage.setItem("queue", "d2");
    const { result } = renderHook(() =>
      useReviewQueueNavigation("queue", docs),
    );

    expect(result.current.docIndex).toBe(1);

    act(() => result.current.navigate(-10));
    expect(result.current.docIndex).toBe(0);
    expect(sessionStorage.getItem("queue")).toBe("d1");

    act(() => result.current.navigate(10));
    expect(result.current.docIndex).toBe(1);
    expect(sessionStorage.getItem("queue")).toBe("d2");
  });

  it("mantém o estado de colapso da lista", () => {
    const { result } = renderHook(() =>
      useReviewQueueNavigation("queue", docs),
    );

    expect(result.current.listCollapsed).toBe(false);
    act(() => result.current.toggleList());
    expect(result.current.listCollapsed).toBe(true);
  });
});
