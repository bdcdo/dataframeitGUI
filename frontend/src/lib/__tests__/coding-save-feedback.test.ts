import { describe, it, expect, vi, beforeEach } from "vitest";
import { toast } from "sonner";
import { notifySaved } from "@/lib/coding-save-feedback";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn() },
}));

beforeEach(() => {
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.warning).mockClear();
});

// A distinção "salvo" vs "concluído" é a metade cliente do #519: um envio que
// deixou obrigatórias em aberto não pode devolver o mesmo sinal de conclusão. Uma
// troca warning→success ou um erro de plural aqui passaria por todos os gates —
// por isso as strings exatas são fixadas.
describe("notifySaved — feedback de save distingue salvo × pendente", () => {
  it("undefined (legacy, sem régua) → sucesso", () => {
    notifySaved(undefined);
    expect(toast.success).toHaveBeenCalledWith("Respostas salvas!");
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("0 obrigatória em aberto → sucesso (boundary com o ramo de pendência)", () => {
    notifySaved(0);
    expect(toast.success).toHaveBeenCalledWith("Respostas salvas!");
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("1 obrigatória em aberto → aviso no singular", () => {
    notifySaved(1);
    expect(toast.warning).toHaveBeenCalledWith(
      "Salvo — o documento segue pendente (falta 1 obrigatória)",
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("N obrigatórias em aberto → aviso no plural com a contagem", () => {
    notifySaved(3);
    expect(toast.warning).toHaveBeenCalledWith(
      "Salvo — o documento segue pendente (faltam 3 obrigatórias)",
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
});
