// @vitest-environment jsdom
//
// Gate da navegação manual extraído de `ComparePage` (#564): com rascunho não
// confirmado ou salvamento em andamento, navegar perderia trabalho (#430).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { useCompareNavGuard } from "../useCompareNavGuard";

const { toastWarning } = vi.hoisted(() => ({ toastWarning: vi.fn() }));
vi.mock("sonner", () => ({ toast: { warning: toastWarning } }));

function setup(hasPendingVerdict: boolean, inFlight: boolean) {
  const raw = {
    handleDocNavigate: vi.fn(),
    setFieldIndex: vi.fn(),
    handleNextDoc: vi.fn(),
    goNextField: vi.fn(),
    goPrevField: vi.fn(),
    changeFilter: vi.fn(),
    changeQueue: vi.fn(),
  };
  const { result } = renderHook(() =>
    useCompareNavGuard({
      hasPendingVerdict,
      isSaveInFlight: () => inFlight,
      ...raw,
    }),
  );
  const nav = result.current;
  nav.navigateDoc(2);
  nav.navigateField(1);
  nav.nextDoc();
  nav.nextField();
  nav.prevField();
  nav.changeFieldFilter("q2");
  nav.changeQueue("all");
  return { raw, nav };
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("useCompareNavGuard", () => {
  it("sem rascunho nem salvamento, toda navegação passa", () => {
    const { raw, nav } = setup(false, false);
    expect(raw.handleDocNavigate).toHaveBeenCalledWith(2);
    expect(raw.setFieldIndex).toHaveBeenCalledWith(1);
    expect(raw.handleNextDoc).toHaveBeenCalledTimes(1);
    expect(raw.goNextField).toHaveBeenCalledTimes(1);
    expect(raw.goPrevField).toHaveBeenCalledTimes(1);
    expect(raw.changeFilter).toHaveBeenCalledWith("q2");
    expect(raw.changeQueue).toHaveBeenCalledWith("all");
    expect(nav.guardNavigation()).toBe(true);
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it("com rascunho pendente, bloqueia tudo e avisa", () => {
    const { raw, nav } = setup(true, false);
    for (const fn of Object.values(raw)) expect(fn).not.toHaveBeenCalled();
    expect(nav.guardNavigation()).toBe(false);
    expect(toastWarning).toHaveBeenCalledWith(
      "Seleção não confirmada — confirme ou descarte antes de avançar.",
      { id: "compare-nav-guard" },
    );
  });

  it.each<[string, boolean]>([
    ["com rascunho", true],
    ["sem rascunho (campo multi, atalhos a/s)", false],
  ])("com salvamento em andamento %s, bloqueia em silêncio", (_name, hasPending) => {
    const { raw, nav } = setup(hasPending, true);
    for (const fn of Object.values(raw)) expect(fn).not.toHaveBeenCalled();
    expect(nav.guardNavigation()).toBe(false);
    expect(toastWarning).not.toHaveBeenCalled();
  });
});
