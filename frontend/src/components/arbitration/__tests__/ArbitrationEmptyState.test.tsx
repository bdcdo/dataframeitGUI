// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ArbitrationEmptyState } from "../ArbitrationEmptyState";

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
