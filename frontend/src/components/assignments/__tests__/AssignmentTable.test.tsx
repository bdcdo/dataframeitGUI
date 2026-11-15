// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { warmUpJsdom } from "@/test-utils/jsdom-warm-up";
import type { Assignment } from "@/lib/types";
import { AssignmentTable } from "../AssignmentTable";

const { cycleAssignment } = vi.hoisted(() => ({ cycleAssignment: vi.fn() }));
vi.mock("@/actions/assignments", () => ({ cycleAssignment }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

// Exigido pela regra test-jsdom-warm-up (eslint-rules/test-jsdom-warm-up.mjs).
beforeAll(() => warmUpJsdom(), 30_000);

afterEach(() => {
  cleanup();
  cycleAssignment.mockReset();
});

const researcher = {
  id: "m1",
  project_id: "p1",
  user_id: "u1",
  role: "pesquisador",
  profiles: { first_name: "Ana", email: "ana@example.com" },
} as unknown as Parameters<typeof AssignmentTable>[0]["researchers"][number];

const pendingCoding: Assignment = {
  id: "a1",
  project_id: "p1",
  document_id: "d1",
  user_id: "u1",
  status: "pendente",
  type: "codificacao",
  batch_id: null,
  completed_at: null,
  round_id: "r1",
};

function table(assignments: Assignment[]) {
  return (
    <AssignmentTable
      projectId="p1"
      documents={[{ id: "d1", external_id: "DOC-1" }]}
      researchers={[researcher]}
      assignments={assignments}
    />
  );
}

describe("AssignmentTable — estado otimista", () => {
  // #551: a criação pode gravar a codificação já como `concluido` (documento
  // codificado pelo Explorar antes da atribuição), e só o servidor sabe disso.
  it("não afirma um status na célula enquanto a criação não volta do servidor", async () => {
    cycleAssignment.mockReturnValue(new Promise(() => {}));
    render(table([]));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Atribuir codificação" }));
    });

    const cell = screen.getByRole("button", { name: "Salvando a atribuição de codificação…" });
    expect(cell.textContent).toBe("C");
    // `bg-brand` é a cor da codificação pendente: a célula não a usa ainda.
    expect(cell.className).not.toMatch(/\bbg-brand\b/);
    expect(cell.getAttribute("aria-busy")).toBe("true");
    // O rodapé também não conta a linha como codificação não concluída.
    expect(screen.getByText("C: 0/0")).toBeTruthy();
    expect(cycleAssignment).toHaveBeenCalledWith("p1", "d1", "u1");
  });

  it("mostra o status que o servidor gravou quando a linha real chega", async () => {
    let finish!: (result: object) => void;
    cycleAssignment.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { rerender } = render(table([]));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Atribuir codificação" }));
    });
    await act(async () => {
      finish({});
      rerender(
        table([{ ...pendingCoding, status: "concluido", completed_at: "2026-11-15T00:00:00Z" }]),
      );
    });

    const cell = screen.getByRole("button", {
      name: "Codificação concluída (clique para atribuir a comparação da própria codificação)",
    });
    expect(cell.textContent).toBe("✓C");
    expect(cell.getAttribute("aria-busy")).toBeNull();
  });

  it("a troca de codificação pendente por comparação segue otimista como pendente", async () => {
    cycleAssignment.mockReturnValue(new Promise(() => {}));
    render(table([pendingCoding]));

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: "Atribuição de codificação (clique para trocar por comparação)",
        }),
      );
    });

    const cell = screen.getByRole("button", {
      name: "Atribuição de comparação (clique para remover)",
    });
    expect(cell.textContent).toBe("R");
    expect(cell.className).toMatch(/\bbg-amber-500\b/);
  });
});
