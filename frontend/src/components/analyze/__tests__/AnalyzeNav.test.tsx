// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { warmUpJsdom } from "@/test-utils/jsdom-warm-up";

const location = vi.hoisted(() => ({ pathname: "", search: "" }));

vi.mock("next/navigation", () => ({
  usePathname: () => location.pathname,
  useSearchParams: () => new URLSearchParams(location.search),
}));

import { AnalyzeNav } from "@/components/analyze/AnalyzeNav";

function tabsAt(pathname: string, search = "") {
  location.pathname = pathname;
  location.search = search;
  render(<AnalyzeNav projectId="p1" />);
  return screen.getAllByRole("link").map((link) => link.textContent);
}

beforeAll(() => warmUpJsdom(), 30_000);
afterEach(cleanup);

// O layout sonda as filas do próprio usuário (não recebe `searchParams`), e a
// página aceita `?viewAsUser=` do master: a fila do membro impersonado abria
// sem aba nenhuma marcada.
describe("AnalyzeNav — master visualizando como outro membro", () => {
  it.each([
    ["arbitragem", "Arbitragem"],
    ["compare", "Comparar"],
  ])("mostra a aba da fila aberta em %s", (route, label) => {
    expect(
      tabsAt(`/projects/p1/analyze/${route}`, "viewAsUser=member-2"),
    ).toEqual(["Atribuições", "Codificar", label]);
  });

  // A auto-revisão ignora a impersonação: a aba dela segue o probe.
  it.each(["code", "auto-revisao"])("não cria aba em %s", (route) => {
    expect(
      tabsAt(`/projects/p1/analyze/${route}`, "viewAsUser=member-2"),
    ).toEqual(["Atribuições", "Codificar"]);
  });

  it("sem impersonação a aba segue o probe do layout", () => {
    expect(tabsAt("/projects/p1/analyze/arbitragem")).toEqual([
      "Atribuições",
      "Codificar",
    ]);
  });
});
