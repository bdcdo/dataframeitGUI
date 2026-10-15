// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { warmUpJsdom } from "@/test-utils/jsdom-warm-up";

// Com timers falsos ligados, warmUpJsdom precisa voltar sem exercitar nada. Se
// não pulasse esse caso, esperaria por setTimeout congelados e o teste
// estouraria o timeout.
vi.useFakeTimers();

it("com timers falsos, o aquecimento volta sem montar nada", async () => {
  await warmUpJsdom({ select: true });
  expect(document.body.innerHTML).toBe("");
});
