import { afterEach, describe, expect, it, vi } from "vitest";
import { serverErrorCopy } from "@/lib/server-error";

describe("serverErrorCopy", () => {
  afterEach(() => vi.restoreAllMocks());

  it("loga {code, message} e devolve a copy genérica", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const copy = serverErrorCopy(
      "[x] falhou",
      { code: "57014", message: "statement timeout" },
      { generic: "Tente novamente." },
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

  it("código fora do mapa cai na genérica", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      serverErrorCopy("[x]", { code: "42501", message: "rls" }, { generic: "G", byCode: { P0001: "S" } }),
    ).toBe("G");
  });
});
