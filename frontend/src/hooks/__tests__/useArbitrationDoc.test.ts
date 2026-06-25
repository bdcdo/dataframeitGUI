// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";

const {
  refresh,
  submitBlindVerdicts,
  submitFinalVerdicts,
  toastError,
  toastSuccess,
} = vi.hoisted(() => ({
  refresh: vi.fn(),
  submitBlindVerdicts: vi.fn(),
  submitFinalVerdicts: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/actions/field-reviews", () => ({
  submitBlindVerdicts,
  submitFinalVerdicts,
}));
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }));

import { useArbitrationDoc } from "../useArbitrationDoc";
import type {
  ArbitrationDoc,
  ArbitrationField,
} from "@/components/arbitration/ArbitrationPage";
import type { ArbitrationVerdict } from "@/lib/types";

function field(
  fieldReviewId: string,
  fieldName: string,
  blindVerdict: ArbitrationVerdict | null = null,
): ArbitrationField {
  return { fieldReviewId, fieldName, aAnswer: "A", bAnswer: "B", blindVerdict, reveal: null };
}

function makeDoc(docId: string, fields: ArbitrationField[]): ArbitrationDoc {
  return { docId, title: docId, externalId: null, text: "txt", fields };
}

function setup(
  doc: ArbitrationDoc | undefined,
  opts: { docIndex?: number; docsLength?: number; onNavigate?: () => void } = {},
) {
  const onNavigate = opts.onNavigate ?? vi.fn();
  const utils = renderHook(
    ({ doc }) =>
      useArbitrationDoc({
        doc,
        docIndex: opts.docIndex ?? 0,
        docsLength: opts.docsLength ?? 1,
        projectId: "p1",
        onNavigate,
      }),
    { initialProps: { doc } },
  );
  return { ...utils, onNavigate };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useArbitrationDoc — derivação de phase", () => {
  it("'blind' quando algum campo não tem blindVerdict", () => {
    const { result } = setup(
      makeDoc("d1", [field("f1", "q1", "humano"), field("f2", "q2", null)]),
    );
    expect(result.current.phase).toBe("blind");
  });

  it("'reveal' quando todos os campos têm blindVerdict", () => {
    const { result } = setup(
      makeDoc("d1", [field("f1", "q1", "humano"), field("f2", "q2", "llm")]),
    );
    expect(result.current.phase).toBe("reveal");
  });

  it("'blind' para doc undefined ou sem campos", () => {
    expect(setup(undefined).result.current.phase).toBe("blind");
    expect(setup(makeDoc("d1", [])).result.current.phase).toBe("blind");
  });
});

describe("useArbitrationDoc — override 'Voltar à cega'", () => {
  it("força 'blind' sem mudar os dados e some ao trocar de doc", () => {
    const { result, rerender } = setup(makeDoc("d1", [field("f1", "q1", "humano")]));
    expect(result.current.phase).toBe("reveal");

    act(() => result.current.onBackToBlind());
    expect(result.current.phase).toBe("blind");

    // Override é chaveado por docId → outro doc revela conforme os dados.
    rerender({ doc: makeDoc("d2", [field("f2", "q2", "llm")]) });
    expect(result.current.phase).toBe("reveal");
  });
});

describe("useArbitrationDoc — effectiveFinalChoices", () => {
  it("preenche o verdict cego como default na reveal e marca allFinalChosen", () => {
    const { result } = setup(
      makeDoc("d1", [field("f1", "q1", "humano"), field("f2", "q2", "llm")]),
    );
    expect(result.current.effectiveFinalChoices).toEqual({ f1: "humano", f2: "llm" });
    expect(result.current.allFinalChosen).toBe(true);
  });

  it("override explícito do usuário vence o default no merge", () => {
    const { result } = setup(makeDoc("d1", [field("f1", "q1", "humano")]));
    act(() => result.current.onChooseFinal("f1", "llm"));
    expect(result.current.effectiveFinalChoices.f1).toBe("llm");
  });

  it("na fase blind é só os overrides (sem default cego)", () => {
    const { result } = setup(makeDoc("d1", [field("f1", "q1", null)]));
    expect(result.current.phase).toBe("blind");
    expect(result.current.effectiveFinalChoices).toEqual({});
  });
});

describe("useArbitrationDoc — allBlindChosen", () => {
  it("reflete blindVerdict do server OU escolha local", () => {
    const { result } = setup(
      makeDoc("d1", [field("f1", "q1", null), field("f2", "q2", "humano")]),
    );
    expect(result.current.allBlindChosen).toBe(false);
    act(() => result.current.onChooseBlind("f1", "a"));
    expect(result.current.allBlindChosen).toBe(true);
  });
});

describe("useArbitrationDoc — handleBlindSubmit", () => {
  it("envia só os campos sem blindVerdict e dá refresh", async () => {
    submitBlindVerdicts.mockResolvedValue({ success: true });
    const { result } = setup(
      makeDoc("d1", [field("f1", "q1", null), field("f2", "q2", "humano")]),
    );
    act(() => result.current.onChooseBlind("f1", "a"));
    await act(async () => {
      await result.current.handleBlindSubmit();
    });
    expect(submitBlindVerdicts).toHaveBeenCalledWith("p1", "d1", [
      { fieldReviewId: "f1", choice: "a" },
    ]);
    expect(refresh).toHaveBeenCalled();
  });

  it("não chama a action quando todos já têm blindVerdict (só refresh)", async () => {
    const { result } = setup(makeDoc("d1", [field("f1", "q1", "humano")]));
    await act(async () => {
      await result.current.handleBlindSubmit();
    });
    expect(submitBlindVerdicts).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalled();
  });

  it("em erro mostra toast e não dá refresh", async () => {
    submitBlindVerdicts.mockResolvedValue({ success: false, error: "boom" });
    const { result } = setup(makeDoc("d1", [field("f1", "q1", null)]));
    act(() => result.current.onChooseBlind("f1", "b"));
    await act(async () => {
      await result.current.handleBlindSubmit();
    });
    expect(toastError).toHaveBeenCalledWith("boom");
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("useArbitrationDoc — handleFinalSubmit", () => {
  it("exige sugestão quando o verdict é 'llm' e não envia", async () => {
    const { result } = setup(makeDoc("d1", [field("f1", "q1", "llm")]));
    await act(async () => {
      await result.current.handleFinalSubmit();
    });
    expect(toastError).toHaveBeenCalled();
    expect(submitFinalVerdicts).not.toHaveBeenCalled();
  });

  it("monta payload com effectiveFinalChoices e avança ao próximo doc", async () => {
    submitFinalVerdicts.mockResolvedValue({ success: true });
    const onNavigate = vi.fn();
    const { result } = setup(makeDoc("d1", [field("f1", "q1", "humano")]), {
      docIndex: 0,
      docsLength: 2,
      onNavigate,
    });
    await act(async () => {
      await result.current.handleFinalSubmit();
    });
    expect(submitFinalVerdicts).toHaveBeenCalledWith("p1", "d1", [
      {
        fieldName: "q1",
        verdict: "humano",
        questionImprovementSuggestion: undefined,
        arbitratorComment: undefined,
      },
    ]);
    expect(toastSuccess).toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledWith(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("no último doc dá refresh em vez de navegar", async () => {
    submitFinalVerdicts.mockResolvedValue({ success: true });
    const onNavigate = vi.fn();
    const { result } = setup(makeDoc("d1", [field("f1", "q1", "humano")]), {
      docIndex: 1,
      docsLength: 2,
      onNavigate,
    });
    await act(async () => {
      await result.current.handleFinalSubmit();
    });
    expect(onNavigate).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalled();
  });

  it("inclui sugestão e comentário no payload do verdict 'llm'", async () => {
    submitFinalVerdicts.mockResolvedValue({ success: true });
    const { result } = setup(makeDoc("d1", [field("f1", "q1", "llm")]), {
      docsLength: 1,
    });
    act(() => {
      result.current.onSuggestion("f1", "melhorar X");
      result.current.onComment("f1", "comentário");
    });
    await act(async () => {
      await result.current.handleFinalSubmit();
    });
    expect(submitFinalVerdicts).toHaveBeenCalledWith("p1", "d1", [
      {
        fieldName: "q1",
        verdict: "llm",
        questionImprovementSuggestion: "melhorar X",
        arbitratorComment: "comentário",
      },
    ]);
  });
});
