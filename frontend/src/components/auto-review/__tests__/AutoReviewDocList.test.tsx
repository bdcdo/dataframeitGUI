// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import {
  AutoReviewDocList,
  type AutoReviewDocListEntry,
} from "../AutoReviewDocList";

afterEach(cleanup);

function entry(
  over: Partial<AutoReviewDocListEntry> = {},
): AutoReviewDocListEntry {
  return {
    id: "doc-id-abcdefgh-rest",
    title: "Documento Um",
    externalId: null,
    totalFields: 3,
    pendingFields: 0,
    ...over,
  };
}

describe("AutoReviewDocList — colapsada", () => {
  it("mostra só o botão de expandir e dispara onToggle", () => {
    const onToggle = vi.fn();
    render(
      <AutoReviewDocList
        docs={[entry()]}
        currentIndex={0}
        onSelect={vi.fn()}
        collapsed
        onToggle={onToggle}
      />,
    );
    expect(screen.queryByText("Fila de auto-revisão")).toBeNull();
    const btn = screen.getByTitle("Mostrar lista de documentos");
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe("AutoReviewDocList — expandida", () => {
  it("lista vazia exibe mensagem dedicada", () => {
    render(
      <AutoReviewDocList
        docs={[]}
        currentIndex={0}
        onSelect={vi.fn()}
        collapsed={false}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText("Nenhum documento na fila.")).toBeTruthy();
  });

  it("recolher dispara onToggle", () => {
    const onToggle = vi.fn();
    render(
      <AutoReviewDocList
        docs={[entry()]}
        currentIndex={0}
        onSelect={vi.fn()}
        collapsed={false}
        onToggle={onToggle}
      />,
    );
    fireEvent.click(screen.getByTitle("Recolher lista"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("título cai para externalId e depois para os 8 primeiros chars do id", () => {
    render(
      <AutoReviewDocList
        docs={[
          entry({ id: "a", title: "Tem título" }),
          entry({ id: "b", title: null, externalId: "EXT-9" }),
          entry({ id: "abcdefgh-XXXX", title: null, externalId: null }),
        ]}
        currentIndex={0}
        onSelect={vi.fn()}
        collapsed={false}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText("Tem título")).toBeTruthy();
    expect(screen.getByText("EXT-9")).toBeTruthy();
    expect(screen.getByText("abcdefgh")).toBeTruthy();
  });

  it("badge de progresso mostra (total - pendentes)/total", () => {
    render(
      <AutoReviewDocList
        docs={[entry({ totalFields: 3, pendingFields: 1 })]}
        currentIndex={0}
        onSelect={vi.fn()}
        collapsed={false}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText(/2\/3/)).toBeTruthy();
  });

  it("clicar num documento chama onSelect com o índice", () => {
    const onSelect = vi.fn();
    render(
      <AutoReviewDocList
        docs={[
          entry({ id: "a", title: "Primeiro" }),
          entry({ id: "b", title: "Segundo" }),
        ]}
        currentIndex={0}
        onSelect={onSelect}
        collapsed={false}
        onToggle={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Segundo").closest("button")!);
    expect(onSelect).toHaveBeenCalledWith(1);
  });
});
