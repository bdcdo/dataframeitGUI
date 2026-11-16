// @vitest-environment jsdom
//
// Comentário extraído de `ComparePage` (#564): semeado do veredito do
// contexto e resetado por guard de render ao trocar de contexto.
import { describe, it, expect, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useCompareCommentDraft } from "../useCompareCommentDraft";

afterEach(cleanup);

function setup(ctxKey: string | null, seed: string) {
  return renderHook(
    ({ ctxKey, seed }: { ctxKey: string | null; seed: string }) =>
      useCompareCommentDraft(ctxKey, seed),
    { initialProps: { ctxKey, seed } },
  );
}

describe("useCompareCommentDraft", () => {
  it("semeia do veredito já na montagem", () => {
    const { result } = setup("d1|q1|false", "salvo");
    expect(result.current[0]).toBe("salvo");
  });

  it("trocar de contexto descarta o rascunho e semeia do novo veredito", () => {
    const { result, rerender } = setup("d1|q1|false", "");
    act(() => result.current[1]("rascunho"));
    rerender({ ctxKey: "d1|q2|false", seed: "do q2" });
    expect(result.current[0]).toBe("do q2");
  });

  it("no mesmo contexto, o texto digitado sobrevive à mudança do veredito", () => {
    const { result, rerender } = setup("d1|q1|false", "");
    act(() => result.current[1]("recém-salvo"));
    rerender({ ctxKey: "d1|q1|false", seed: "recém-salvo" });
    rerender({ ctxKey: "d1|q1|false", seed: "outro" });
    expect(result.current[0]).toBe("recém-salvo");
  });

  it("entrar em impersonação (readOnly na chave) descarta o rascunho", () => {
    const { result, rerender } = setup("d1|q1|false", "");
    act(() => result.current[1]("rascunho"));
    rerender({ ctxKey: "d1|q1|true", seed: "" });
    expect(result.current[0]).toBe("");
  });
});
