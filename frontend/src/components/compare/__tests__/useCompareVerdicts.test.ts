// @vitest-environment jsdom
//
// Cobertura de regressão para a issue #366 ("não tá indo a resposta da
// equivalencia"): antes da PR #362, os handlers deste hook chamavam
// `recordReview`/`goNextField` (escrita otimista) sem antes checar se a
// Server Action tinha de fato falhado — e a Action lançava Error, mascarado
// pelo Next 16 em produção, então o handler nunca chegava a ver o erro. Hoje
// as três actions retornam `{ error? }`; estes testes travam que a escrita
// otimista só ocorre quando `result.error` é ausente.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { submitVerdict, markCompareDocReviewed } from "@/actions/reviews";
import {
  confirmEquivalentVerdict,
  unmarkEquivalencePair,
} from "@/actions/equivalences";
import { useCompareVerdicts } from "../useCompareVerdicts";
import type { CompareDocument, FieldResponse } from "../compare-types";

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/actions/reviews", () => ({
  submitVerdict: vi.fn(),
  markCompareDocReviewed: vi.fn(),
}));
vi.mock("@/actions/equivalences", () => ({
  confirmEquivalentVerdict: vi.fn(),
  unmarkEquivalencePair: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

const mockSubmitVerdict = vi.mocked(submitVerdict);
const mockMarkReviewed = vi.mocked(markCompareDocReviewed);
const mockConfirmEquivalent = vi.mocked(confirmEquivalentVerdict);
const mockUnmarkPair = vi.mocked(unmarkEquivalencePair);

const DOC: CompareDocument = {
  id: "doc1",
  title: "Doc 1",
  external_id: null,
  text: "texto",
};

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

function setup() {
  const recordReview = vi.fn();
  const goNextField = vi.fn();
  const { result } = renderHook(() =>
    useCompareVerdicts({
      projectId: "p1",
      currentDoc: DOC,
      currentFieldName: "q1",
      isCurrentFieldDivergent: true,
      allDocDivergent: ["q1", "q2"],
      localReviews: {},
      fieldResponses: [] as FieldResponse[],
      comment: "",
      recordReview,
      goNextField,
    }),
  );
  return { result, recordReview, goNextField };
}

describe("handleVerdict", () => {
  it("submitVerdict retorna { error } → não grava otimista, não avança, mostra toast.error", async () => {
    mockSubmitVerdict.mockResolvedValue({ error: "falhou" });
    const { result, recordReview, goNextField } = setup();

    await act(async () => {
      await result.current.handleVerdict("concordo", "r1");
    });

    expect(recordReview).not.toHaveBeenCalled();
    expect(goNextField).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith("falhou");
  });

  it("sucesso → grava o veredito otimista e avança de campo", async () => {
    mockSubmitVerdict.mockResolvedValue({});
    const { result, recordReview, goNextField } = setup();

    await act(async () => {
      await result.current.handleVerdict("concordo", "r1");
    });

    expect(recordReview).toHaveBeenCalledWith("doc1", "q1", {
      verdict: "concordo",
      chosenResponseId: "r1",
      comment: null,
    });
    expect(goNextField).toHaveBeenCalledTimes(1);
  });
});

describe("handleConfirmEquivalent — o caminho da issue #366", () => {
  it("confirmEquivalentVerdict retorna { error } → não grava otimista, não avança, mostra toast.error", async () => {
    mockConfirmEquivalent.mockResolvedValue({ error: "não foi" });
    const { result, recordReview, goNextField } = setup();

    await act(async () => {
      await result.current.handleConfirmEquivalent(["r1", "r2"], "r1", "fundida");
    });

    expect(recordReview).not.toHaveBeenCalled();
    expect(goNextField).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith("não foi");
  });

  it("sucesso → grava o gabarito como veredito otimista e avança de campo", async () => {
    mockConfirmEquivalent.mockResolvedValue({});
    const { result, recordReview, goNextField } = setup();

    await act(async () => {
      await result.current.handleConfirmEquivalent(["r1", "r2"], "r1", "fundida");
    });

    expect(recordReview).toHaveBeenCalledWith("doc1", "q1", {
      verdict: "fundida",
      chosenResponseId: "r1",
      comment: null,
    });
    expect(goNextField).toHaveBeenCalledTimes(1);
  });
});

describe("handleUnmarkPair", () => {
  it("unmarkEquivalencePair retorna { error } → mostra toast.error", async () => {
    mockUnmarkPair.mockResolvedValue({ error: "não desfez" });
    const { result } = setup();

    await act(async () => {
      await result.current.handleUnmarkPair("pair1");
    });

    expect(toastError).toHaveBeenCalledWith("não desfez");
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("sucesso → mostra toast.success", async () => {
    mockUnmarkPair.mockResolvedValue({});
    const { result } = setup();

    await act(async () => {
      await result.current.handleUnmarkPair("pair1");
    });

    expect(toastSuccess).toHaveBeenCalledWith("Equivalência removida.");
  });
});

describe("handleMarkReviewed", () => {
  it("markCompareDocReviewed retorna { error } → mostra toast.error", async () => {
    mockMarkReviewed.mockResolvedValue({ error: "não marcou" });
    const { result } = setup();

    await act(async () => {
      await result.current.handleMarkReviewed();
    });

    expect(toastError).toHaveBeenCalledWith("não marcou");
  });
});
