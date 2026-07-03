// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CompareQueueTabs } from "@/components/compare/CompareQueueTabs";

afterEach(cleanup);

describe("CompareQueueTabs — toggle controlado (sem estado próprio de URL)", () => {
  it("reflete `value` na aba ativa", () => {
    render(<CompareQueueTabs value="mine" onValueChange={vi.fn()} />);
    expect(
      screen.getByRole("tab", { name: "Meus atribuídos" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByRole("tab", { name: "Todos" }).getAttribute("aria-selected"),
    ).toBe("false");
  });

  it("clicar em 'Todos' chama onValueChange('all') sem mexer na URL sozinho", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<CompareQueueTabs value="mine" onValueChange={onValueChange} />);

    await user.click(screen.getByRole("tab", { name: "Todos" }));

    expect(onValueChange).toHaveBeenCalledWith("all");
  });

  it("clicar em 'Meus atribuídos' chama onValueChange('mine')", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<CompareQueueTabs value="all" onValueChange={onValueChange} />);

    await user.click(screen.getByRole("tab", { name: "Meus atribuídos" }));

    expect(onValueChange).toHaveBeenCalledWith("mine");
  });
});
