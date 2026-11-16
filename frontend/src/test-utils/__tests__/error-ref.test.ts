import { describe, expect, it } from "vitest";

import { copyWithRef, loggedLine } from "@/test-utils/error-ref";

describe("loggedLine", () => {
  const line = '[erro 1a2b3c] [x] passo falhou {"code":"57014","message":"timeout"}';

  it("aceita o escopo exato e confere só as chaves pedidas do JSON", () => {
    expect(line).toEqual(loggedLine("[x] passo falhou"));
    expect(line).toEqual(loggedLine("[x] passo falhou", { message: "timeout" }));
    expect(line).toEqual(loggedLine(/\[x\] .* falhou/, { code: "57014" }));
    expect(line).toEqual(loggedLine("[x] passo falhou", { message: expect.stringContaining("time") }));
  });

  it("recusa escopo diferente, payload diferente e linha sem código", () => {
    expect(line).not.toEqual(loggedLine("[x] passo"));
    expect(line).not.toEqual(loggedLine("[x] passo falhou", { code: "23505" }));
    expect('[x] passo falhou {"code":"57014"}').not.toEqual(loggedLine("[x] passo falhou"));
  });
});

describe("copyWithRef", () => {
  it("exige a copy inteira seguida do código", () => {
    expect("Tente novamente. — código 1a2b3c").toEqual(copyWithRef("Tente novamente."));
    expect("Tente novamente.").not.toEqual(copyWithRef("Tente novamente."));
    expect("Erro. Tente novamente. — código 1a2b3c").not.toEqual(copyWithRef("Tente novamente."));
  });
});
