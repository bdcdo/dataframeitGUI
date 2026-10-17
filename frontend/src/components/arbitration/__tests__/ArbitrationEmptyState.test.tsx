// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { warmUpJsdom } from "@/test-utils/jsdom-warm-up";
import { render, screen, cleanup } from "@testing-library/react";
import { ArbitrationEmptyState } from "../ArbitrationEmptyState";

// Exigido pela regra test-jsdom-warm-up (eslint-rules/test-jsdom-warm-up.mjs).
beforeAll(() => warmUpJsdom(), 30_000);

afterEach(cleanup);

describe("ArbitrationEmptyState", () => {
  it("renderiza o título e a mensagem de fila vazia", () => {
    render(<ArbitrationEmptyState />);
    expect(
      screen.getByRole("heading", { name: "Arbitragem" }),
    ).toBeTruthy();
    expect(
      screen.getByText(/Nenhuma arbitragem pendente/),
    ).toBeTruthy();
  });
});
