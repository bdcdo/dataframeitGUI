// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FieldRenderer } from "@/components/coding/FieldRenderer";
import type { PydanticField } from "@/lib/types";

afterEach(cleanup);

const dateField: PydanticField = {
  name: "data_evento",
  type: "date",
  options: null,
  description: "Data do evento",
};

function lastOnChangeCall(onChange: ReturnType<typeof vi.fn>): unknown {
  const calls = onChange.mock.calls;
  return calls[calls.length - 1]?.[0];
}

describe("FieldRenderer (date) — race condition regression", () => {
  it("preserves both digits when typing '12' in the day field (PR #92)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    const { rerender } = render(
      <FieldRenderer field={dateField} value="" onChange={onChange} />,
    );

    const dayInput = screen.getByLabelText("Dia") as HTMLInputElement;
    const monthInput = screen.getByLabelText("Mês") as HTMLInputElement;

    // Simulate the controlled-input loop: each onChange call updates the value prop.
    onChange.mockImplementation((v: string) => {
      rerender(<FieldRenderer field={dateField} value={v} onChange={onChange} />);
    });

    await user.click(dayInput);
    await user.keyboard("12");

    // The bug produced "01" because handleBlur padded stale parts before
    // setParts({day: "12"}) committed. After the fix, the day must be "12".
    expect(dayInput.value).toBe("12");
    expect(lastOnChangeCall(onChange)).toBe("12/XX/XXXX");
    expect(document.activeElement).toBe(monthInput);
  });

  it("auto-pads single-digit day on blur (PR #90)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    const { rerender } = render(
      <FieldRenderer field={dateField} value="" onChange={onChange} />,
    );

    const dayInput = screen.getByLabelText("Dia") as HTMLInputElement;

    onChange.mockImplementation((v: string) => {
      rerender(<FieldRenderer field={dateField} value={v} onChange={onChange} />);
    });

    await user.click(dayInput);
    await user.keyboard("5");
    await user.tab();

    expect(dayInput.value).toBe("05");
    expect(lastOnChangeCall(onChange)).toBe("05/XX/XXXX");
  });

  it("selects pre-filled content on focus so typing overwrites (PR #91)", () => {
    const onChange = vi.fn();

    render(
      <FieldRenderer
        field={dateField}
        value="05/XX/XXXX"
        onChange={onChange}
      />,
    );

    const dayInput = screen.getByLabelText("Dia") as HTMLInputElement;
    expect(dayInput.value).toBe("05");

    // Focusing must trigger the onFocus={select()} handler so the next
    // keystroke replaces "05" instead of appending. We assert the selection
    // directly instead of relying on userEvent's keystroke-vs-selection
    // semantics in jsdom, which are not faithful to real browsers.
    dayInput.focus();
    expect(dayInput.selectionStart).toBe(0);
    expect(dayInput.selectionEnd).toBe(2);
  });
});
