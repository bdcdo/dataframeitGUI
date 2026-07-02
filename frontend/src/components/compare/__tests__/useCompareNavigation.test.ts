// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, cleanup, act } from "@testing-library/react";

const toastInfo = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { info: toastInfo } }));

import { useCompareNavigation } from "@/components/compare/useCompareNavigation";
import type { CompareDocument } from "@/components/compare/compare-types";

const doc = (id: string): CompareDocument => ({
  id,
  title: `Doc ${id}`,
  external_id: null,
  text: "",
});

function renderNav(documents: CompareDocument[]) {
  return renderHook(
    (props: { documents: CompareDocument[] }) =>
      useCompareNavigation({
        documents: props.documents,
        divergentFields: {},
        fields: [],
        localReviews: {},
      }),
    { initialProps: { documents } },
  );
}

afterEach(() => {
  cleanup();
  toastInfo.mockClear();
});

describe("useCompareNavigation — pin do doc exibido", () => {
  // Regressão do bug #73 (caso residual): revisar o primeiro doc da fila sem
  // navegação explícita + re-sort do servidor a cada veredito não pode trocar
  // o parecer sob o usuário.
  it("mantém o doc exibido quando `documents` é reordenado sem navegação explícita", () => {
    const A = doc("A");
    const B = doc("B");
    const { result, rerender } = renderNav([A, B]);

    expect(result.current.currentDoc?.id).toBe("A");

    // Simula o revalidate pós-veredito: A perdeu pendências e afundou no sort.
    rerender({ documents: [B, A] });

    expect(result.current.currentDoc?.id).toBe("A");
    expect(result.current.docIndex).toBe(1);
  });

  it("re-pina o novo doc exibido quando o pinado some da lista (com toast, sem novo salto)", () => {
    const A = doc("A");
    const B = doc("B");
    const C = doc("C");
    const { result, rerender } = renderNav([A, B]);

    // A é excluído da fila → cai para o novo topo (B) e avisa uma vez.
    rerender({ documents: [B] });
    expect(result.current.currentDoc?.id).toBe("B");
    expect(toastInfo).toHaveBeenCalledTimes(1);

    // Novo re-sort não pode mover o usuário de novo: B ficou pinado.
    rerender({ documents: [C, B] });
    expect(result.current.currentDoc?.id).toBe("B");
    expect(toastInfo).toHaveBeenCalledTimes(1);
  });

  it("pina o primeiro doc que chegar quando a lista está vazia na montagem", () => {
    const A = doc("A");
    const B = doc("B");
    const { result, rerender } = renderNav([]);

    expect(result.current.currentDoc).toBeUndefined();

    rerender({ documents: [A, B] });
    expect(result.current.currentDoc?.id).toBe("A");

    rerender({ documents: [B, A] });
    expect(result.current.currentDoc?.id).toBe("A");
  });

  it("navegação explícita continua re-pinando normalmente", () => {
    const A = doc("A");
    const B = doc("B");
    const { result, rerender } = renderNav([A, B]);

    act(() => result.current.handleDocNavigate(1));
    expect(result.current.currentDoc?.id).toBe("B");

    rerender({ documents: [B, A] });
    expect(result.current.currentDoc?.id).toBe("B");
    expect(result.current.docIndex).toBe(0);
  });
});
