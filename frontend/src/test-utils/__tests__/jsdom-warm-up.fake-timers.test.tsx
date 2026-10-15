// @vitest-environment jsdom
import { expect, it, vi } from "vitest";

// Timers falsos ligados na coleta, antes do aquecimento de
// src/test-utils/jsdom-warm-up.tsx. Se o hook não pulasse esse caso, ele
// esperaria por setTimeout congelados até estourar o prazo, e o teste abaixo
// seria pulado com o erro do hook.
vi.useFakeTimers();

it("um arquivo com timers falsos desde a coleta roda os testes", () => {
  expect(vi.isFakeTimers()).toBe(true);
});
