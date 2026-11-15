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

// O React emaranha as transições assíncronas pendentes: uma action que nunca
// volta prenderia o otimista dos testes seguintes. Toda chamada pendente é
// resolvida ao fim do teste.
const pending: ((result: object) => void)[] = [];
function serverCall() {
  return new Promise<object>((resolve) => pending.push(resolve));
}

afterEach(async () => {
  await act(async () => {
    for (const resolve of pending.splice(0)) resolve({});
  });
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
    cycleAssignment.mockReturnValue(serverCall());
    render(table([]));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Atribuir codificação" }));
    });

    const cell = screen.getByRole("button", { name: "Salvando a atribuição…" });
    expect(cell.textContent).toBe("C");
    // `bg-brand` é a cor da codificação pendente: a célula não a usa ainda.
    expect(cell.className).not.toMatch(/\bbg-brand\b/);
    expect(cell.getAttribute("aria-busy")).toBe("true");
    // O rodapé também não conta a linha como codificação não concluída.
    expect(screen.getByText("C: 0/0")).toBeTruthy();
    expect(cycleAssignment).toHaveBeenCalledWith("p1", "d1", "u1");
  });

  it("mostra o status que o servidor gravou quando a linha real chega", async () => {
    cycleAssignment.mockReturnValue(serverCall());
    const { rerender } = render(table([]));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Atribuir codificação" }));
    });
    await act(async () => {
      pending.shift()!({});
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

  // #880: só o servidor sabe se o pesquisador codificou o documento. Se
  // codificou, a action pede a confirmação da autocomparação sem gravar nada:
  // a célula não pode afirmar "R" nesse meio-tempo.
  it("a troca de codificação pendente por comparação não afirma o R antes do servidor", async () => {
    cycleAssignment.mockReturnValue(serverCall());
    render(table([pendingCoding]));

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: "Atribuição de codificação (clique para trocar por comparação)",
        }),
      );
    });

    expect(screen.queryByText("R")).toBeNull();
    const saving = screen.getByRole("button", { name: "Salvando a atribuição…" });
    expect(saving.textContent).toBe("C");
    expect(saving.className).not.toMatch(/\bbg-amber-500\b/);
    expect(saving.getAttribute("aria-busy")).toBe("true");
    // O rodapé segue contando a codificação real, como a célula que ainda a
    // mostra: tirá-la do C afirmaria a troca que a célula deixou de afirmar.
    expect(screen.getByText("C: 0/1")).toBeTruthy();
    expect(screen.getByText("R: 0/0")).toBeTruthy();

    await act(async () => {
      pending.shift()!({ needsSelfComparisonConfirmation: true });
    });

    // A action não gravou: a célula volta à codificação pendente, e o diálogo
    // de confirmação abre (e, modal, tira a tabela da árvore acessível).
    const cell = screen.getByRole("button", {
      name: "Atribuição de codificação (clique para trocar por comparação)",
      hidden: true,
    });
    expect(cell.textContent).toBe("C");
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    // Cancelar não grava nada: a codificação pendente fica como estava.
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Atribuição de codificação (clique para trocar por comparação)",
      }).textContent,
    ).toBe("C");
    expect(screen.getByText("C: 0/1")).toBeTruthy();
    expect(cycleAssignment).toHaveBeenCalledTimes(1);
  });

  it("a troca gravada pelo servidor mostra o R quando a linha real chega", async () => {
    cycleAssignment.mockReturnValue(serverCall());
    const { rerender } = render(table([pendingCoding]));

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: "Atribuição de codificação (clique para trocar por comparação)",
        }),
      );
    });
    await act(async () => {
      pending.shift()!({});
      rerender(table([{ ...pendingCoding, type: "comparacao" }]));
    });

    const cell = screen.getByRole("button", {
      name: "Atribuição de comparação (clique para remover)",
    });
    expect(cell.textContent).toBe("R");
    expect(cell.getAttribute("aria-busy")).toBeNull();
    expect(screen.getByText("C: 0/0")).toBeTruthy();
    expect(screen.getByText("R: 0/1")).toBeTruthy();
  });
});
