// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// next/navigation mockado: capturamos o `push` para inspecionar a URL que o
// filtro monta. `useSearchParams` devolve um URLSearchParams real (readCompare
// Filters faz `instanceof URLSearchParams`).
const push = vi.hoisted(() => vi.fn());
let searchParams: URLSearchParams;
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => searchParams,
  usePathname: () => "/projects/p1/analyze/compare",
}));

import { CompareFilters } from "@/components/compare/CompareFilters";

// Radix (Popover/Select) usa APIs de Pointer/observer que o jsdom não tem.
beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.scrollIntoView = () => {};
  proto.hasPointerCapture = () => false;
  proto.setPointerCapture = () => {};
  proto.releasePointerCapture = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

beforeEach(() => {
  push.mockClear();
  searchParams = new URLSearchParams("");
});
afterEach(() => cleanup());

async function openVersionSelect(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /Filtros/i }));
  // O seletor "Desde a versão" é o primeiro combobox do popover.
  const comboboxes = await screen.findAllByRole("combobox");
  await user.click(comboboxes[0]);
}

describe("CompareFilters — alcançabilidade de 'Todas as versões' (#247/#286)", () => {
  // REGRESSÃO #247: com o default VIVO latest_major, "Todas as versões" só é
  // alcançável se o param `version=all` for ESCRITO na URL — porque `update`
  // apaga params que coincidem com o default, e 'all' ≠ 'latest_major'. Este é o
  // locus real do fix (o `update()` do componente), que os testes puros de
  // readCompareFilters não exercitavam.
  it("default latest_major: selecionar 'Todas as versões' escreve version=all na URL", async () => {
    const user = userEvent.setup();
    render(
      <CompareFilters
        respondentNames={[]}
        defaultMinHumans={2}
        defaultVersion="latest_major"
        availableVersions={[]}
        latestMajorLabel="2.0.0"
      />,
    );
    await openVersionSelect(user);
    const listbox = await screen.findByRole("listbox");
    await user.click(within(listbox).getByText("Todas as versões"));

    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0]).toContain("version=all");
  });

  it("default latest_major: re-selecionar 'Última MAJOR' apaga o param (volta ao default)", async () => {
    const user = userEvent.setup();
    searchParams = new URLSearchParams("version=all");
    render(
      <CompareFilters
        respondentNames={[]}
        defaultMinHumans={2}
        defaultVersion="latest_major"
        availableVersions={[]}
        latestMajorLabel="2.0.0"
      />,
    );
    await openVersionSelect(user);
    const listbox = await screen.findByRole("listbox");
    await user.click(within(listbox).getByText(/Última MAJOR/));

    expect(push).toHaveBeenCalledTimes(1);
    // 'latest_major' === default → o param é removido (não fica preso na URL).
    expect(push.mock.calls[0][0]).not.toContain("version=");
  });

  it("default all: selecionar 'Todas as versões' apaga o param (coincide com o default)", async () => {
    const user = userEvent.setup();
    searchParams = new URLSearchParams("version=latest_major");
    render(
      <CompareFilters
        respondentNames={[]}
        defaultMinHumans={2}
        defaultVersion="all"
        availableVersions={[]}
        latestMajorLabel="2.0.0"
      />,
    );
    await openVersionSelect(user);
    const listbox = await screen.findByRole("listbox");
    await user.click(within(listbox).getByText("Todas as versões"));

    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0]).not.toContain("version=");
  });
});
