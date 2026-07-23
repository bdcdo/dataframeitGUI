// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";

import { useCompareCommentDraft } from "@/components/compare/useCompareCommentDraft";
import type { VerdictInfo } from "@/lib/compare-reviews";

afterEach(cleanup);

const verdict = (comment: string | null): VerdictInfo => ({
  verdict: "v",
  chosenResponseId: null,
  comment,
});

function render(currentVerdict: VerdictInfo | null, ctxKey: string | null) {
  return renderHook(
    (props: { currentVerdict: VerdictInfo | null; ctxKey: string | null }) =>
      useCompareCommentDraft(props),
    { initialProps: { currentVerdict, ctxKey } },
  );
}

describe("useCompareCommentDraft — guard de render (#430)", () => {
  it("semeia o comentário do veredito existente já na montagem", () => {
    const { result } = render(verdict("nota A"), "d1|a|false");
    expect(result.current.comment).toBe("nota A");
  });

  it("re-semeia do novo veredito ao trocar de campo", () => {
    const { result, rerender } = render(verdict("nota A"), "d1|a|false");
    act(() => result.current.setComment("rascunho não salvo"));
    expect(result.current.comment).toBe("rascunho não salvo");

    rerender({ currentVerdict: verdict("nota B"), ctxKey: "d1|b|false" });
    expect(result.current.comment).toBe("nota B");
  });

  it("campo novo sem veredito zera a caixa", () => {
    const { result, rerender } = render(verdict("nota A"), "d1|a|false");
    rerender({ currentVerdict: null, ctxKey: "d1|c|false" });
    expect(result.current.comment).toBe("");
  });

  it("preserva o comentário editado quando o ctxKey não muda", () => {
    const { result, rerender } = render(verdict("nota A"), "d1|a|false");
    act(() => result.current.setComment("editado"));
    // Mesmo par (doc, campo): não re-semeia (preserva o recém-digitado/salvo).
    rerender({ currentVerdict: verdict("nota A"), ctxKey: "d1|a|false" });
    expect(result.current.comment).toBe("editado");
  });

  it("trocar readOnly (impersonação) descarta o rascunho da identidade anterior", () => {
    const { result, rerender } = render(verdict("nota A"), "d1|a|false");
    act(() => result.current.setComment("rascunho do master"));
    rerender({ currentVerdict: verdict("nota A"), ctxKey: "d1|a|true" });
    expect(result.current.comment).toBe("nota A");
  });
});
