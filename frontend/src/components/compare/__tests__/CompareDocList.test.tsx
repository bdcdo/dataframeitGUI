// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { CompareDocList, type DocListEntry } from "../CompareDocList";

afterEach(cleanup);

function entry(over: Partial<DocListEntry> = {}): DocListEntry {
  return {
    id: "doc-id-abcdefgh-rest",
    title: "Documento Um",
    external_id: null,
    humanCount: 0,
    totalCount: 0,
    assignedCodingCount: 0,
    humansFromAssigned: 0,
    divergentCount: 0,
    reviewedCount: 0,
    assignmentStatus: null,
    ...over,
  };
}

describe("CompareDocList — colapsada", () => {
  it("mostra só o botão de expandir e dispara onToggle", () => {
    const onToggle = vi.fn();
    render(
      <CompareDocList
        docs={[entry()]}
        currentIndex={0}
        onSelect={vi.fn()}
        collapsed
        onToggle={onToggle}
      />,
    );
    expect(screen.queryByText("Fila de revisão")).toBeNull();
    const btn = screen.getByTitle("Mostrar lista de documentos");
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe("CompareDocList — expandida", () => {
  it("lista vazia exibe mensagem dedicada", () => {
    render(
      <CompareDocList
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
      <CompareDocList
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

  it("título cai para external_id e depois para os 8 primeiros chars do id", () => {
    render(
      <CompareDocList
        docs={[
          entry({ id: "a", title: "Tem título" }),
          entry({ id: "b", title: null, external_id: "EXT-9" }),
          entry({ id: "abcdefgh-XXXX", title: null, external_id: null }),
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

  it("badges de humanos, respostas totais e revisados/divergentes", () => {
    render(
      <CompareDocList
        docs={[
          entry({
            humansFromAssigned: 2,
            assignedCodingCount: 3,
            totalCount: 5,
            reviewedCount: 1,
            divergentCount: 2,
          }),
        ]}
        currentIndex={0}
        onSelect={vi.fn()}
        collapsed={false}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText(/2\/3/)).toBeTruthy();
    expect(screen.getByText("5 resp.")).toBeTruthy();
    expect(screen.getByText(/1\/2/)).toBeTruthy();
  });

  it("badge de humanos omite o denominador quando assignedCodingCount é 0", () => {
    render(
      <CompareDocList
        docs={[entry({ humansFromAssigned: 1, assignedCodingCount: 0 })]}
        currentIndex={0}
        onSelect={vi.fn()}
        collapsed={false}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText("👤 1")).toBeTruthy();
  });

  it.each([
    ["concluido", "text-green-600"],
    ["em_andamento", "text-amber-600"],
    [null, "text-muted-foreground/50"],
  ] as const)("StatusDot reflete o estado %s", (status, expectedClass) => {
    const { container } = render(
      <CompareDocList
        docs={[entry({ assignmentStatus: status })]}
        currentIndex={0}
        onSelect={vi.fn()}
        collapsed={false}
        onToggle={vi.fn()}
      />,
    );
    const icon = container.querySelector("ul svg");
    expect(icon?.getAttribute("class")).toContain(expectedClass);
  });

  it("clicar num documento chama onSelect com o índice", () => {
    const onSelect = vi.fn();
    render(
      <CompareDocList
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
