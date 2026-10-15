// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import { warmUpJsdom, type WarmUpPhase } from "@/test-utils/jsdom-warm-up";

let ran: WarmUpPhase[] = [];
beforeAll(async () => {
  ran = await warmUpJsdom({ select: true });
}, 30_000);

// warmUpJsdom instala stubs de Radix só enquanto roda; se algum sobrevivesse,
// um arquivo que renderiza Radix sem declarar os stubs passaria por acaso.
describe("aquecimento de arquivo jsdom", () => {
  it("percorre o Dialog e o Select", () => {
    expect(ran).toEqual(["dialog", "select"]);
  });

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
