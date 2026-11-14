// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { warmUpJsdom } from "@/test-utils/jsdom-warm-up";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FieldFilterSelect } from "@/components/shared/FieldFilterSelect";

// Radix Select usa APIs de Pointer/observer que o jsdom não tem.
beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.scrollIntoView = () => {};
  proto.hasPointerCapture = () => false;
  proto.setPointerCapture = () => {};
  proto.releasePointerCapture = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

// Exigido pela regra test-jsdom-warm-up (eslint-rules/test-jsdom-warm-up.mjs).
beforeAll(() => warmUpJsdom({ select: true }), 30_000);

afterEach(cleanup);

const fields = [
  { name: "q1", description: "Pergunta um" },
  { name: "q2", description: "" },
];

describe("FieldFilterSelect", () => {
  it("lista 'Todos os campos' e cada campo pela descrição, ou pelo nome sem ela", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <FieldFilterSelect value="all" onChange={onChange} fields={fields} className="w-44" />,
    );

    const trigger = screen.getByRole("combobox");
    expect(trigger.textContent).toBe("Todos os campos");
    expect(trigger.className).toContain("w-44");

    await user.click(trigger);
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "Todos os campos",
      "Pergunta um",
      "q2",
    ]);

    await user.click(screen.getByRole("option", { name: "q2" }));
    expect(onChange).toHaveBeenCalledWith("q2");
  });
});
