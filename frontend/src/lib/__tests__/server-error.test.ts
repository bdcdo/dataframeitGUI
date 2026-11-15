import { afterEach, describe, expect, it, vi } from "vitest";
import {
  actionErrorMessage,
  caughtErrorCopy,
  errorCode,
  errorDetail,
  serverErrorCopy,
  serverErrorScope,
} from "@/lib/server-error";
import { maskedServerError } from "@/test-utils/masked-server-error";

describe("serverErrorCopy", () => {
  afterEach(() => vi.restoreAllMocks());

  it("código fora do mapa loga {code, message} e devolve a copy genérica", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const copy = serverErrorCopy(
      "[x] falhou",
      { code: "57014", message: "statement timeout" },
      { generic: "Tente novamente.", byCode: { P0001: "Já resolvida." } },
    );
    expect(copy).toBe("Tente novamente.");
    expect(consoleError).toHaveBeenCalledWith("[x] falhou", {
      code: "57014",
      message: "statement timeout",
    });
  });

  it("código mapeado ganha copy própria e não vai ao log", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const copy = serverErrorCopy(
      "[x] falhou",
      { code: "P0001", message: "suggestion not pending" },
      { generic: "Tente novamente.", byCode: { P0001: "Já resolvida." } },
    );
    expect(copy).toBe("Já resolvida.");
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe("serverErrorScope", () => {
  afterEach(() => vi.restoreAllMocks());

  it("monta o escopo `[modulo] passo falhou` e devolve a copy genérica", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const copy = serverErrorScope("members")(
      "leitura do e-mail",
      { code: "57014", message: "statement timeout" },
      "Tente novamente.",
    );
    expect(copy).toBe("Tente novamente.");
    expect(consoleError).toHaveBeenCalledWith("[members] leitura do e-mail falhou", {
      code: "57014",
      message: "statement timeout",
    });
  });
});

describe("caughtErrorCopy", () => {
  afterEach(() => vi.restoreAllMocks());

  it("loga o code string do erro capturado, quando há", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const coded = Object.assign(new Error("statement timeout"), { code: "57014" });
    expect(caughtErrorCopy("[x] falhou", coded, "Tente novamente.")).toBe("Tente novamente.");
    expect(consoleError).toHaveBeenCalledWith("[x] falhou", {
      code: "57014",
      message: "statement timeout",
    });
  });

  it("code não string (status do ApiError) e erro sem code saem com code undefined", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    caughtErrorCopy("[x] falhou", Object.assign(new Error("boom"), { code: 502 }), "g");
    caughtErrorCopy("[x] falhou", new TypeError("fetch failed"), "g");
    expect(consoleError).toHaveBeenNthCalledWith(1, "[x] falhou", { code: undefined, message: "boom" });
    expect(consoleError).toHaveBeenNthCalledWith(2, "[x] falhou", {
      code: undefined,
      message: "fetch failed",
    });
  });
});

describe("errorCode", () => {
  it("digest numérico vira código curto em base 36", () => {
    expect(errorCode(maskedServerError("2876531478"))).toBe("1bkm1w6");
    // Teto do hash de 32 bits: nunca passa de 7 caracteres.
    expect(errorCode(maskedServerError("4294967295"))).toBe("1z141z3");
    // Digest pequeno é completado, para o código ter sempre 6+ caracteres.
    expect(errorCode(maskedServerError("1234"))).toBe("0000ya");
  });

  it("erro de controle do Next e erro sem digest não têm código", () => {
    expect(errorCode(maskedServerError("NEXT_REDIRECT;replace;/x;307;"))).toBeNull();
    expect(errorCode(maskedServerError("NEXT_HTTP_ERROR_FALLBACK;404"))).toBeNull();
    expect(errorCode(new Error("falha no cliente"))).toBeNull();
    expect(errorCode({ digest: 123 })).toBeNull();
    expect(errorCode("texto")).toBeNull();
    expect(errorCode(null)).toBeNull();
  });
});

describe("actionErrorMessage", () => {
  it("exceção de Server Action vira a copy pt-BR do fluxo com o código, e não o texto em inglês do Next", () => {
    expect(actionErrorMessage(maskedServerError("2876531478"), "Erro ao salvar")).toBe(
      "Erro ao salvar — código 1bkm1w6",
    );
  });

  it("erro do cliente mantém a mensagem; sem mensagem, cai na copy", () => {
    expect(actionErrorMessage(new Error("Falha de rede"), "Erro ao salvar")).toBe("Falha de rede");
    expect(actionErrorMessage(new Error(""), "Erro ao salvar")).toBe("Erro ao salvar");
    expect(actionErrorMessage("Falha de rede", "Erro ao salvar")).toBe("Falha de rede");
    expect(actionErrorMessage({}, "Erro ao salvar")).toBe("Erro ao salvar");
  });
});

describe("errorDetail", () => {
  it("erro de servidor mostra o código, nunca a mensagem mascarada", () => {
    expect(errorDetail(maskedServerError("2876531478"))).toBe("Código do erro: 1bkm1w6");
  });

  it("erro do navegador mostra a mensagem; sem mensagem, nada", () => {
    expect(errorDetail(new Error("Cannot read properties of undefined"))).toBe(
      "Cannot read properties of undefined",
    );
    expect(errorDetail(new Error(""))).toBeNull();
    expect(errorDetail(undefined)).toBeNull();
  });
});
