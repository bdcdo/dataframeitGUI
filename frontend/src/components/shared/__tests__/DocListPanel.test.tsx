// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { DocListPanel } from "../DocListPanel";

afterEach(cleanup);

describe("DocListPanel — colapsado", () => {
  it("mostra só o botão de expandir, acessível por title e aria-label, e dispara onToggle", () => {
    const onToggle = vi.fn();
    render(
      <DocListPanel
        collapsed
        onToggle={onToggle}
        headerLabel="Fila de teste"
        isEmpty={false}
      >
        <li>item</li>
      </DocListPanel>,
    );
    expect(screen.queryByText("Fila de teste")).toBeNull();
    const btn = screen.getByRole("button", {
      name: "Mostrar lista de documentos",
    });
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe("DocListPanel — expandido", () => {
  it("mostra o headerLabel e dispara onToggle ao recolher, acessível por title e aria-label", () => {
    const onToggle = vi.fn();
    render(
      <DocListPanel
        collapsed={false}
        onToggle={onToggle}
        headerLabel="Fila de teste"
        isEmpty={false}
      >
        <li>item</li>
      </DocListPanel>,
    );
    expect(screen.getByText("Fila de teste")).toBeTruthy();
    const btn = screen.getByRole("button", { name: "Recolher lista" });
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("isEmpty=true mostra a mensagem dedicada e não renderiza children", () => {
    render(
      <DocListPanel
        collapsed={false}
        onToggle={vi.fn()}
        headerLabel="Fila de teste"
        isEmpty
      >
        <li>não deveria aparecer</li>
      </DocListPanel>,
    );
    expect(screen.getByText("Nenhum documento na fila.")).toBeTruthy();
    expect(screen.queryByText("não deveria aparecer")).toBeNull();
  });

  it("isEmpty=false renderiza children dentro da lista", () => {
    render(
      <DocListPanel
        collapsed={false}
        onToggle={vi.fn()}
        headerLabel="Fila de teste"
        isEmpty={false}
      >
        <li>item visível</li>
      </DocListPanel>,
    );
    expect(screen.getByText("item visível")).toBeTruthy();
    expect(screen.queryByText("Nenhum documento na fila.")).toBeNull();
  });
});
