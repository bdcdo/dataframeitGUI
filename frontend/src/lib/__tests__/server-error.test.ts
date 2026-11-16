import { afterEach, describe, expect, it, vi } from "vitest";
import { UnrecognizedActionError } from "next/dist/client/components/unrecognized-action-error";
import {
  actionErrorMessage,
  caughtErrorCopy,
  errorCode,
  errorDetail,
  isStaleActionError,
  STALE_PAGE_ERROR,
  withErrorCode,
  serverErrorCopy,
  serverErrorScope,
} from "@/lib/server-error";
import { copyWithRef, loggedLine } from "@/test-utils/error-ref";
import { maskedServerError } from "@/test-utils/masked-server-error";

describe("serverErrorCopy", () => {
  afterEach(() => vi.restoreAllMocks());

  it("código fora do mapa loga {code, message} e devolve a copy genérica com o código", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const copy = serverErrorCopy(
      "[x] falhou",
      { code: "57014", message: "statement timeout" },
      { generic: "Tente novamente.", byCode: { P0001: "Já resolvida." } },
    );
    expect(copy).toEqual(copyWithRef("Tente novamente."));
    expect(consoleError).toHaveBeenCalledWith(
      loggedLine("[x] falhou", { code: "57014", message: "statement timeout" }),
    );
  });

  // Sem digest do Next, o código é sorteado: o mesmo no toast e na linha do
  // log, e outro no erro seguinte.
  it("o código do toast é o da linha do log, e cada erro ganha o seu", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = { code: "57014", message: "statement timeout" };
    const first = serverErrorCopy("[x] falhou", error, { generic: "Tente novamente." });
    const second = serverErrorCopy("[x] falhou", error, { generic: "Tente novamente." });
    const ref = (copy: string) => copy.split(" — código ")[1];
    // Uma linha só: o grep pelo código traz também o code e a mensagem.
    expect(consoleError.mock.calls[0]).toEqual([
      `[erro ${ref(first)}] [x] falhou {"code":"57014","message":"statement timeout"}`,
    ]);
    expect(consoleError.mock.calls[1][0]).toMatch(new RegExp(`^\\[erro ${ref(second)}\\] `));
    expect(ref(first)).not.toBe(ref(second));
  });

  // No navegador (fetchFastAPI de componente cliente) o log vai para o console
  // de quem usa, e um código ali não acharia nada no log do servidor.
  it("no navegador devolve a copy sem código", () => {
    vi.stubGlobal("window", {});
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = { code: "502", message: "Bad Gateway" };
    expect(serverErrorCopy("[api] /x falhou", error, { generic: "Tente novamente." })).toBe(
      "Tente novamente.",
    );
    expect(consoleError).toHaveBeenCalledWith("[api] /x falhou", error);
    vi.unstubAllGlobals();
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
    expect(copy).toEqual(copyWithRef("Tente novamente."));
    expect(consoleError).toHaveBeenCalledWith(
      loggedLine("[members] leitura do e-mail falhou", { code: "57014", message: "statement timeout" }),
    );
  });
});

describe("caughtErrorCopy", () => {
  afterEach(() => vi.restoreAllMocks());

  it("loga o code string do erro capturado, quando há", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const coded = Object.assign(new Error("statement timeout"), { code: "57014" });
    expect(caughtErrorCopy("[x] falhou", coded, "Tente novamente.")).toEqual(
      copyWithRef("Tente novamente."),
    );
    expect(consoleError).toHaveBeenCalledWith(
      loggedLine("[x] falhou", { code: "57014", message: "statement timeout" }),
    );
  });

  it("code não string (status do ApiError) e erro sem code saem com code undefined", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    caughtErrorCopy("[x] falhou", Object.assign(new Error("boom"), { code: 502 }), "g");
    caughtErrorCopy("[x] falhou", new TypeError("fetch failed"), "g");
    expect(consoleError).toHaveBeenNthCalledWith(
      1,
      loggedLine("[x] falhou", { message: "boom" }),
    );
    expect(consoleError).toHaveBeenNthCalledWith(
      2,
      loggedLine("[x] falhou", { message: "fetch failed" }),
    );
    // Sem code string, a linha não leva a chave.
    expect(consoleError.mock.calls.flat().join()).not.toContain('"code"');
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

describe("withErrorCode", () => {
  const copy = "Não foi possível remover o membro. Tente novamente.";

  it("acrescenta à copy fixa o código da exceção do servidor", () => {
    expect(withErrorCode(maskedServerError("2876531478"), copy)).toBe(
      `${copy} — código 1bkm1w6`,
    );
  });

  it("erro do navegador mantém a copy pt-BR, sem a mensagem em inglês", () => {
    expect(withErrorCode(new TypeError("Failed to fetch"), copy)).toBe(copy);
    expect(withErrorCode(undefined, copy)).toBe(copy);
  });
});

// O que o cliente do Next lança quando a aba é anterior ao deploy que trocou os
// IDs das Server Actions. A classe real, de propósito: se uma atualização do
// Next trocar o nome, este teste acusa (ver `isStaleActionError`).
describe("Server Action desconhecida pelo servidor", () => {
  const stale = new UnrecognizedActionError('Server Action "7f00" was not found on the server.');

  it("é reconhecida pela classe real do Next, e erro comum não", () => {
    expect(isStaleActionError(stale)).toBe(true);
    expect(isStaleActionError(new Error("Server Action not found"))).toBe(false);
    expect(isStaleActionError(maskedServerError())).toBe(false);
  });

  it("pede para recarregar, nos dois helpers do toast", () => {
    expect(withErrorCode(stale, "Não foi possível remover o membro. Tente novamente.")).toBe(
      STALE_PAGE_ERROR,
    );
    expect(actionErrorMessage(stale, "Erro ao salvar")).toBe(STALE_PAGE_ERROR);
    expect(STALE_PAGE_ERROR).toContain("Recarregue a página");
  });
});
