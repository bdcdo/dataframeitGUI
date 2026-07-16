// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("sonner", () => ({ toast }));

import {
  buildRetriableToggleMessage,
  useTogglePermission,
} from "../useTogglePermission";

describe("useTogglePermission", () => {
  it("informa a rejeição da action e limpa o estado pendente", async () => {
    const startTransition = (callback: () => void) => callback();
    const { result } = renderHook(() =>
      useTogglePermission(
        async () => {
          throw new Error("rede indisponível");
        },
        (value) => ({ can_compare: value }),
        () => "Atualizado",
        vi.fn(),
        startTransition,
      ),
    );

    act(() => result.current.toggle("member-1", true));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("rede indisponível"));
    expect(result.current.pendingId).toBeNull();
  });
});

describe("buildRetriableToggleMessage", () => {
  it("sem retried, retorna só o verbo", () => {
    expect(buildRetriableToggleMessage("Arbitragem habilitada", "árbitro")).toBe(
      "Arbitragem habilitada."
    );
  });

  it("com casos realocados e ainda sem pool, detalha os dois números", () => {
    const msg = buildRetriableToggleMessage("Arbitragem habilitada", "árbitro", {
      assigned: 2,
      stillNoPool: 1,
    });
    expect(msg).toBe(
      "Arbitragem habilitada. 2 caso(s) realocado(s); 1 ainda sem árbitro elegível."
    );
  });

  it("com casos realocados e nenhum restante sem pool, omite a segunda parte", () => {
    const msg = buildRetriableToggleMessage("Comparação habilitada", "revisor", {
      assigned: 3,
      stillNoPool: 0,
    });
    expect(msg).toBe("Comparação habilitada. 3 caso(s) realocado(s).");
  });

  it("com retried mas assigned=0, degrada para a mensagem simples", () => {
    const msg = buildRetriableToggleMessage("Comparação desabilitada", "revisor", {
      assigned: 0,
      stillNoPool: 0,
    });
    expect(msg).toBe("Comparação desabilitada.");
  });
});
