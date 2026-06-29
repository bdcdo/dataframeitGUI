// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import {
  ArbitrationDocList,
  type ArbitrationDocListEntry,
} from "../ArbitrationDocList";

afterEach(cleanup);

function entry(
  over: Partial<ArbitrationDocListEntry> = {},
): ArbitrationDocListEntry {
  return {
    id: "doc-id-abcdefgh-rest",
    title: "Documento Um",
    externalId: null,
    totalFields: 3,
    blindDecided: 0,
    finalDecided: 0,
    ...over,
  };
}

describe("ArbitrationDocList — colapsada", () => {
  it("mostra só o botão de expandir e dispara onToggle", () => {
    const onToggle = vi.fn();
    render(
      <ArbitrationDocList
        docs={[entry()]}
        currentIndex={0}
        onSelect={vi.fn()}
        collapsed
        onToggle={onToggle}
      />,
    );
    expect(screen.queryByText("Fila de arbitragem")).toBeNull();
    const btn = screen.getByTitle("Mostrar lista de documentos");
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe("ArbitrationDocList — expandida", () => {
  it("lista vazia exibe mensagem dedicada", () => {
    render(
      <ArbitrationDocList
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
      <ArbitrationDocList
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
      <ArbitrationDocList
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

  it("badge de fase: 'Revelação' quando blindDecided==total, senão 'Cega'", () => {
    render(
      <ArbitrationDocList
        docs={[
          entry({ id: "a", title: "Cega ainda", blindDecided: 1, totalFields: 3 }),
          entry({ id: "b", title: "Revelado", blindDecided: 2, totalFields: 2 }),
        ]}
        currentIndex={0}
        onSelect={vi.fn()}
        collapsed={false}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText("Cega")).toBeTruthy();
    expect(screen.getByText("Revelação")).toBeTruthy();
  });

  it("badge de progresso mostra finalDecided/total", () => {
    render(
      <ArbitrationDocList
        docs={[entry({ finalDecided: 2, totalFields: 3 })]}
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
      <ArbitrationDocList
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
