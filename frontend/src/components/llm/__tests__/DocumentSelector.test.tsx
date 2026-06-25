// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DocSelectionItem } from "@/actions/llm";

// `getDocumentsForSelection` é uma server action; mocká-la corta a cadeia de
// imports server-only (supabase) e nos dá controle sobre o fetch ao abrir.
const getDocumentsForSelection = vi.hoisted(() => vi.fn());
vi.mock("@/actions/llm", () => ({ getDocumentsForSelection }));

import { DocumentSelector } from "@/components/llm/DocumentSelector";

const sampleDocs: DocSelectionItem[] = [
  {
    id: "d1",
    title: "Documento Um",
    external_id: "EXT-1",
    hasHumanResponse: true,
    llmResponseCount: 0,
  },
  {
    id: "d2",
    title: "Documento Dois",
    external_id: "EXT-2",
    hasHumanResponse: false,
    llmResponseCount: 2,
  },
];

// O Radix (Dialog/Checkbox) usa APIs de Pointer/observer que o jsdom não
// implementa; sem estes shims a abertura do dialog quebra.
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
    }
  );
});

beforeEach(() => {
  getDocumentsForSelection.mockResolvedValue(sampleDocs);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// pointerEventsCheck: 0 — o overlay do Radix usa pointer-events que confundem
// a checagem padrão do user-event em jsdom.
const setup = () => userEvent.setup({ pointerEventsCheck: 0 });

describe("DocumentSelector", () => {
  it("busca os documentos ao abrir o dialog", async () => {
    const user = setup();
    render(
      <DocumentSelector
        projectId="p1"
        selectedIds={[]}
        onSelectionChange={vi.fn()}
      />
    );

    await user.click(
      screen.getByRole("button", { name: /selecionar documentos/i })
    );

    await screen.findByText("Documento Um");
    expect(getDocumentsForSelection).toHaveBeenCalledWith("p1");
  });

  it("Confirmar propaga a seleção via onSelectionChange", async () => {
    const user = setup();
    const onSelectionChange = vi.fn();
    render(
      <DocumentSelector
        projectId="p1"
        selectedIds={[]}
        onSelectionChange={onSelectionChange}
      />
    );

    await user.click(
      screen.getByRole("button", { name: /selecionar documentos/i })
    );
    await screen.findByText("Documento Um");

    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[0]); // d1

    await user.click(screen.getByRole("button", { name: /confirmar/i }));

    expect(onSelectionChange).toHaveBeenCalledWith(["d1"]);
  });

  it("Cancelar fecha sem propagar a seleção", async () => {
    const user = setup();
    const onSelectionChange = vi.fn();
    render(
      <DocumentSelector
        projectId="p1"
        selectedIds={[]}
        onSelectionChange={onSelectionChange}
      />
    );

    await user.click(
      screen.getByRole("button", { name: /selecionar documentos/i })
    );
    await screen.findByText("Documento Um");

    await user.click(screen.getAllByRole("checkbox")[0]);
    await user.click(screen.getByRole("button", { name: /cancelar/i }));

    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it("re-semeia o draft a partir de selectedIds a cada abertura", async () => {
    const user = setup();
    render(
      <DocumentSelector
        projectId="p1"
        selectedIds={["d1"]}
        onSelectionChange={vi.fn()}
      />
    );

    await user.click(
      screen.getByRole("button", { name: /1 documento selecionado/i })
    );
    await screen.findByText("Documento Um");

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes[0].getAttribute("aria-checked")).toBe("true"); // d1
    expect(checkboxes[1].getAttribute("aria-checked")).toBe("false"); // d2
  });
});
