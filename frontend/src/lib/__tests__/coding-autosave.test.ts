import { describe, it, expect, vi, beforeEach } from "vitest";
import { saveResponse } from "@/actions/responses";
import { toast } from "sonner";
import {
  autosaveDirtyDoc,
  saveCodingResponse,
  CODING_SAVE_TRANSPORT_ERROR,
  CODING_AUTOSAVE_TRANSPORT_ERROR,
} from "@/lib/coding-autosave";

vi.mock("@/actions/responses", () => ({ saveResponse: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockSave = vi.mocked(saveResponse);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("saveCodingResponse", () => {
  it("normaliza a rejeição de transporte para o contrato de falha", async () => {
    mockSave.mockRejectedValue(new Error("Failed to find Server Action"));

    const result = await saveCodingResponse("p1", "d1", { q: "sim" });

    expect(result).toEqual({
      success: false,
      error: CODING_SAVE_TRANSPORT_ERROR,
    });
  });

  it("devolve a falha do handler sem reescrevê-la como erro de transporte", async () => {
    mockSave.mockResolvedValue({
      success: false,
      error: "Documento removido do escopo do projeto",
    });

    const result = await saveCodingResponse("p1", "d1", { q: "sim" });

    expect(result).toEqual({
      success: false,
      error: "Documento removido do escopo do projeto",
    });
  });
});

// Este é o único caminho fire-and-forget: a navegação acontece de qualquer
// forma, então a falha não pode limpar a sujeira do documento — é ela que
// mantém o doc na fila para uma nova tentativa.
describe("autosaveDirtyDoc", () => {
  const params = () => ({
    projectId: "p1",
    docId: "d1",
    answers: { q: "sim" },
    notes: "nota",
    markClean: vi.fn(),
  });

  it("não limpa a sujeira e usa a mensagem de navegação quando o transporte rejeita", async () => {
    mockSave.mockRejectedValue(new Error("Failed to find Server Action"));
    const p = params();

    autosaveDirtyDoc(p);
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalled());

    expect(p.markClean).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(CODING_AUTOSAVE_TRANSPORT_ERROR);
    // A mensagem do save aguardado ("continuam nesta página") apontaria para o
    // documento que o pesquisador acabou de deixar.
    expect(toast.error).not.toHaveBeenCalledWith(CODING_SAVE_TRANSPORT_ERROR);
  });

  it("propaga a mensagem do handler quando a falha não é de transporte", async () => {
    mockSave.mockResolvedValue({
      success: false,
      error: "Documento removido do escopo do projeto",
    });
    const p = params();

    autosaveDirtyDoc(p);
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalled());

    expect(p.markClean).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "Documento removido do escopo do projeto",
    );
  });

  it("limpa a sujeira e salva como autosave no sucesso", async () => {
    mockSave.mockResolvedValue({ success: true });
    const p = params();

    autosaveDirtyDoc(p);
    await vi.waitFor(() => expect(p.markClean).toHaveBeenCalledWith("d1"));

    expect(mockSave).toHaveBeenCalledWith(
      "p1",
      "d1",
      { q: "sim" },
      { notes: "nota", isAutoSave: true },
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("não deixa unhandled rejection se um efeito posterior ao save falhar", async () => {
    mockSave.mockResolvedValue({ success: true });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const p = {
      ...params(),
      markClean: vi.fn(() => {
        throw new Error("markClean explodiu");
      }),
    };

    autosaveDirtyDoc(p);
    await vi.waitFor(() => expect(p.markClean).toHaveBeenCalled());
    await new Promise((r) => setImmediate(r));

    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
