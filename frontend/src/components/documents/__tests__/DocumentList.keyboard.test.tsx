// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  DocumentList,
  type DocumentSummary,
} from "@/components/documents/DocumentList";

afterEach(cleanup);

const docs: DocumentSummary[] = [
  { id: "d1", external_id: "EXT-1", title: "Primeiro documento" },
  { id: "d2", external_id: "EXT-2", title: "Segundo documento" },
];

function renderList(extra: Partial<Parameters<typeof DocumentList>[0]> = {}) {
  const onSelect = vi.fn();
  const onToggleSelect = vi.fn();
  render(
    <DocumentList
      documents={docs}
      onSelect={onSelect}
      projectId="p1"
      {...extra}
    />,
  );
  return { onSelect, onToggleSelect };
}

function rowFor(title: string) {
  const row = screen.getByText(title).closest("tr");
  if (!row) throw new Error(`linha não encontrada para ${title}`);
  return row;
}

/**
 * A linha inteira é o alvo de clique para abrir o documento. Sem `tabIndex` e
 * sem handler de teclado, abrir um documento era exclusivo do mouse
 * (react-doctor `click-events-have-key-events`).
 */
describe("DocumentList — abrir documento pelo teclado", () => {
  it("abre com Enter e com espaço quando a linha tem o foco", async () => {
    const user = userEvent.setup();
    const { onSelect } = renderList();

    const row = rowFor("Primeiro documento");
    row.focus();
    expect(document.activeElement).toBe(row);

    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].id).toBe("d1");

    await user.keyboard(" ");
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("ignora outras teclas", async () => {
    const user = userEvent.setup();
    const { onSelect } = renderList();

    rowFor("Segundo documento").focus();
    await user.keyboard("{Escape}");
    await user.keyboard("a");

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("não abre o documento quando a tecla parte de um controle interno", async () => {
    const user = userEvent.setup();
    const onToggleSelect = vi.fn();
    render(
      <DocumentList
        documents={docs}
        onSelect={vi.fn()}
        projectId="p1"
        selectedIds={new Set<string>()}
        onToggleSelect={onToggleSelect}
      />,
    );

    // O espaço sobre a checkbox de seleção pertence à checkbox: se subisse
    // para a linha, marcar um documento também o abriria.
    const checkbox = screen.getAllByRole("checkbox")[1];
    checkbox.focus();
    await user.keyboard(" ");

    expect(onToggleSelect).toHaveBeenCalledTimes(1);
  });
});
