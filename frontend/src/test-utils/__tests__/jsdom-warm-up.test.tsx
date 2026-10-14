// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

// O aquecimento de src/test-utils/jsdom-warm-up.tsx já rodou quando este teste
// começa. Ele instala stubs de Radix só enquanto roda; se algum sobrevivesse, um
// arquivo que renderiza Radix sem declarar os stubs passaria por acaso.
describe("aquecimento dos arquivos jsdom", () => {
  it("não deixa stubs de jsdom instalados", () => {
    const proto = Element.prototype as unknown as Record<string, unknown>;
    expect(proto.scrollIntoView).toBeUndefined();
    expect(proto.hasPointerCapture).toBeUndefined();
    expect(proto.setPointerCapture).toBeUndefined();
    expect(proto.releasePointerCapture).toBeUndefined();
    expect((globalThis as Record<string, unknown>).ResizeObserver).toBeUndefined();
  });

  it("não deixa nada montado nem trava o body", () => {
    expect(document.body.innerHTML).toBe("");
    expect(document.body.getAttribute("style") ?? "").not.toContain("pointer-events");
    expect(document.body.hasAttribute("data-scroll-locked")).toBe(false);
  });
});
