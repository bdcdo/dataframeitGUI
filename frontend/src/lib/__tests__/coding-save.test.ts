import { describe, it, expect, vi, beforeEach } from "vitest";
import { UnrecognizedActionError } from "next/dist/client/components/unrecognized-action-error";
import { saveResponse } from "@/actions/responses";
import {
  saveCodingResponse,
  CODING_SAVE_TRANSPORT_ERROR,
  CODING_SAVE_STALE_PAGE_ERROR,
} from "@/lib/coding-save";

vi.mock("@/actions/responses", () => ({ saveResponse: vi.fn() }));

const mockSave = vi.mocked(saveResponse);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("saveCodingResponse", () => {
  it("normaliza a rejeição de transporte para o contrato de falha", async () => {
    mockSave.mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await saveCodingResponse("p1", "d1", { q: "sim" }, {
      expectedRoundId: "round-1",
    });

    expect(result).toEqual({
      success: false,
      error: CODING_SAVE_TRANSPORT_ERROR,
    });
  });

  // Depois de um deploy que trocou os IDs das Server Actions, o cliente do Next
  // lança `UnrecognizedActionError` (o servidor responde 404 com o header
  // `x-nextjs-action-not-found`). Repetir o envio não resolve: a mensagem manda
  // recarregar, e não "tente novamente sem recarregar".
  it("action desconhecida pelo servidor pede recarga, não nova tentativa", async () => {
    mockSave.mockRejectedValue(
      new UnrecognizedActionError('Server Action "7f00" was not found on the server.'),
    );

    const result = await saveCodingResponse("p1", "d1", { q: "sim" }, {
      expectedRoundId: "round-1",
    });

    expect(result).toEqual({ success: false, error: CODING_SAVE_STALE_PAGE_ERROR });
    expect(CODING_SAVE_STALE_PAGE_ERROR).toContain("Recarregue a página");
    expect(CODING_SAVE_STALE_PAGE_ERROR).not.toContain("sem recarregar");
  });

  it("devolve a falha do handler sem reescrevê-la como erro de transporte", async () => {
    mockSave.mockResolvedValue({
      success: false,
      error: "Documento removido do escopo do projeto",
    });

    const result = await saveCodingResponse("p1", "d1", { q: "sim" }, {
      expectedRoundId: "round-1",
    });

    expect(result).toEqual({
      success: false,
      error: "Documento removido do escopo do projeto",
    });
  });
});
