// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
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
import { maskedServerError } from "@/test-utils/masked-server-error";
import { ACTION_TIMEOUT_MESSAGE, ACTION_TIMEOUT_MS } from "@/lib/action-timeout";

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
        fieldReviewId: "f1",
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
        fieldReviewId: "f1",
        fieldName: "q1",
        verdict: "llm",
        questionImprovementSuggestion: "melhorar X",
        arbitratorComment: "comentário",
      },
    ]);
  });

  it("comentário vazio não vai no payload (vira undefined)", async () => {
    submitFinalVerdicts.mockResolvedValue({ success: true });
    const { result } = setup(makeDoc("d1", [field("f1", "q1", "humano")]), {
      docsLength: 1,
    });
    act(() => result.current.onComment("f1", ""));
    await act(async () => {
      await result.current.handleFinalSubmit();
    });
    expect(submitFinalVerdicts).toHaveBeenCalledWith("p1", "d1", [
      expect.objectContaining({ arbitratorComment: undefined }),
    ]);
  });

  it("exige sugestão só do PRIMEIRO campo 'llm' sem sugestão", async () => {
    const { result } = setup(
      makeDoc("d1", [field("f1", "q1", "llm"), field("f2", "q2", "llm")]),
    );
    act(() => result.current.onSuggestion("f1", "ok"));
    await act(async () => {
      await result.current.handleFinalSubmit();
    });
    // f1 tem sugestão, f2 não → erro cita f2, e nada é enviado.
    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining("q2"),
    );
    expect(submitFinalVerdicts).not.toHaveBeenCalled();
  });

  it("envia quando todos os campos 'llm' têm sugestão", async () => {
    submitFinalVerdicts.mockResolvedValue({ success: true });
    const { result } = setup(
      makeDoc("d1", [field("f1", "q1", "llm"), field("f2", "q2", "humano")]),
      { docsLength: 1 },
    );
    act(() => result.current.onSuggestion("f1", "melhorar"));
    await act(async () => {
      await result.current.handleFinalSubmit();
    });
    expect(submitFinalVerdicts).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("em erro mostra toast e não navega nem reseta", async () => {
    submitFinalVerdicts.mockResolvedValue({ success: false, error: "falhou" });
    const onNavigate = vi.fn();
    const { result } = setup(makeDoc("d1", [field("f1", "q1", "humano")]), {
      docsLength: 2,
      onNavigate,
    });
    await act(async () => {
      await result.current.handleFinalSubmit();
    });
    expect(toastError).toHaveBeenCalledWith("falhou");
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe("useArbitrationDoc — limpeza de override e reset de estado", () => {
  it("avançar (blind submit) limpa o override e a fase volta a reveal", async () => {
    const { result } = setup(makeDoc("d1", [field("f1", "q1", "humano")]));
    act(() => result.current.onBackToBlind());
    expect(result.current.phase).toBe("blind");
    await act(async () => {
      await result.current.handleBlindSubmit();
    });
    // Sem campos pendentes → não chama a action, mas limpa o override.
    expect(submitBlindVerdicts).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("reveal");
  });

  it("após enviar o final, zera blindChoices/finalChoices/suggestions/comments", async () => {
    submitFinalVerdicts.mockResolvedValue({ success: true });
    const { result } = setup(makeDoc("d1", [field("f1", "q1", "humano")]), {
      docsLength: 1,
    });
    act(() => {
      result.current.onChooseBlind("f1", "a");
      result.current.onChooseFinal("f1", "llm");
      result.current.onSuggestion("f1", "s");
      result.current.onComment("f1", "c");
    });
    expect(result.current.effectiveFinalChoices.f1).toBe("llm");
    await act(async () => {
      await result.current.handleFinalSubmit();
    });
    expect(result.current.blindChoices).toEqual({});
    expect(result.current.suggestions).toEqual({});
    expect(result.current.comments).toEqual({});
    // finalChoices cru zerado → effective volta ao default do verdict cego.
    expect(result.current.effectiveFinalChoices).toEqual({ f1: "humano" });
  });
});

describe("useArbitrationDoc — guardas e estado exposto", () => {
  it("com doc undefined os submits são no-op", async () => {
    const onNavigate = vi.fn();
    const { result } = setup(undefined, { onNavigate });
    await act(async () => {
      await result.current.handleBlindSubmit();
      await result.current.handleFinalSubmit();
    });
    expect(submitBlindVerdicts).not.toHaveBeenCalled();
    expect(submitFinalVerdicts).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("blind submit mapeia todos os campos pendentes (multi-campo)", async () => {
    submitBlindVerdicts.mockResolvedValue({ success: true });
    const { result } = setup(
      makeDoc("d1", [field("f1", "q1", null), field("f2", "q2", null)]),
    );
    act(() => {
      result.current.onChooseBlind("f1", "a");
      result.current.onChooseBlind("f2", "b");
    });
    await act(async () => {
      await result.current.handleBlindSubmit();
    });
    expect(submitBlindVerdicts).toHaveBeenCalledWith("p1", "d1", [
      { fieldReviewId: "f1", choice: "a" },
      { fieldReviewId: "f2", choice: "b" },
    ]);
  });

  it("onSuggestion e onComment expõem o estado por fieldReviewId", () => {
    const { result } = setup(makeDoc("d1", [field("f1", "q1", "humano")]));
    act(() => {
      result.current.onSuggestion("f1", "sug");
      result.current.onComment("f1", "com");
    });
    expect(result.current.suggestions).toEqual({ f1: "sug" });
    expect(result.current.comments).toEqual({ f1: "com" });
  });

  it("submitting fica true durante o envio e volta a false ao fim", async () => {
    let resolveAction: (v: { success: boolean }) => void = () => {};
    submitBlindVerdicts.mockReturnValue(
      new Promise((r) => {
        resolveAction = r;
      }),
    );
    const { result } = setup(makeDoc("d1", [field("f1", "q1", null)]));
    act(() => result.current.onChooseBlind("f1", "a"));
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.handleBlindSubmit();
    });
    expect(result.current.submitting).toBe(true);
    await act(async () => {
      resolveAction({ success: true });
      await pending;
    });
    expect(result.current.submitting).toBe(false);
  });
});

// Uma action que rejeita (rede, erro do servidor) não pode deixar `submitting`
// preso em true: o botão de envio ficaria desabilitado até recarregar a página
// (react-doctor `no-loading-flag-reset-outside-finally`, 0.9.22). E o usuário
// precisa ver que o envio falhou, em vez de o botão só destravar em silêncio.
describe("useArbitrationDoc — action que rejeita", () => {
  // A rejeição é logada antes do toast; silencia a saída no teste.
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("handleBlindSubmit avisa o erro, devolve submitting a false e não avança", async () => {
    submitBlindVerdicts.mockRejectedValue(maskedServerError());
    const { result } = setup(makeDoc("d1", [field("f1", "q1", null)]));
    act(() => result.current.onChooseBlind("f1", "a"));
    await act(async () => {
      await result.current.handleBlindSubmit();
    });
    expect(toastError).toHaveBeenCalledWith(
      "Não foi possível registrar o veredito cego. Tente novamente. — código 1bkm1w6",
    );
    expect(console.error).toHaveBeenCalled();
    expect(result.current.submitting).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    expect(result.current.blindChoices).toEqual({ f1: "a" });
  });

  it("handleFinalSubmit avisa o erro, devolve submitting a false e não avança", async () => {
    submitFinalVerdicts.mockRejectedValue(maskedServerError());
    const onNavigate = vi.fn();
    const { result } = setup(makeDoc("d1", [field("f1", "q1", "humano")]), {
      docsLength: 2,
      onNavigate,
    });
    act(() => result.current.onComment("f1", "c"));
    await act(async () => {
      await result.current.handleFinalSubmit();
    });
    expect(toastError).toHaveBeenCalledWith(
      "Não foi possível enviar o veredito final. Tente novamente. — código 1bkm1w6",
    );
    expect(console.error).toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(result.current.submitting).toBe(false);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(result.current.comments).toEqual({ f1: "c" });
  });
});

// Action que nunca responde (fetch descartado num redeploy): o prazo do envio
// destrava o botão e avisa, em vez de deixar o `await` pendurado.
describe("useArbitrationDoc — action que nunca responde", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("veredito cego: avisa, destrava e mantém as escolhas", async () => {
    submitBlindVerdicts.mockReturnValue(new Promise(() => {}));
    const { result } = setup(makeDoc("d1", [field("f1", "q1", null)]));
    act(() => result.current.onChooseBlind("f1", "b"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let submit!: Promise<void>;
    act(() => {
      submit = result.current.handleBlindSubmit();
    });
    expect(result.current.submitting).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTION_TIMEOUT_MS);
      await submit;
    });
    expect(toastError).toHaveBeenCalledWith(ACTION_TIMEOUT_MESSAGE);
    expect(result.current.submitting).toBe(false);
    expect(result.current.blindChoices).toEqual({ f1: "b" });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("veredito final: avisa, destrava e não navega", async () => {
    submitFinalVerdicts.mockReturnValue(new Promise(() => {}));
    const onNavigate = vi.fn();
    const { result } = setup(makeDoc("d1", [field("f1", "q1", "humano")]), {
      docsLength: 2,
      onNavigate,
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let submit!: Promise<void>;
    act(() => {
      submit = result.current.handleFinalSubmit();
    });
    expect(result.current.submitting).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTION_TIMEOUT_MS);
      await submit;
    });
    expect(toastError).toHaveBeenCalledWith(ACTION_TIMEOUT_MESSAGE);
    expect(result.current.submitting).toBe(false);
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
