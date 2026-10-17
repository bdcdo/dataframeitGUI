// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { warmUpJsdom } from "@/test-utils/jsdom-warm-up";
import { pasteInto } from "@/test-utils/paste-into";

beforeAll(() => warmUpJsdom(), 30_000);
afterEach(cleanup);

function ControlledPair({ onChange }: { onChange: (value: string) => void }) {
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  return (
    <>
      <input
        aria-label="Primeiro"
        value={first}
        onChange={(event) => {
          setFirst(event.target.value);
          onChange(event.target.value);
        }}
      />
      <input aria-label="Segundo" value={second} onChange={(event) => setSecond(event.target.value)} />
    </>
  );
}

describe("pasteInto", () => {
  it("entrega o texto todo ao campo controlado num único onChange", async () => {
    const onChange = vi.fn();
    render(<ControlledPair onChange={onChange} />);

    await pasteInto(screen.getByLabelText("Primeiro"), "Descrição editada");

    expect((screen.getByLabelText("Primeiro") as HTMLInputElement).value).toBe("Descrição editada");
    expect(onChange.mock.calls).toEqual([["Descrição editada"]]);
  });

  // O paste cola no elemento com foco: sem o clique do helper, o texto iria
  // para o campo focado antes, e não para o que o teste pediu.
  it("cola no campo pedido mesmo com o foco em outro", async () => {
    const user = userEvent.setup();
    render(<ControlledPair onChange={vi.fn()} />);
    await user.click(screen.getByLabelText("Segundo"));

    await pasteInto(screen.getByLabelText("Primeiro"), "abc", user);

    expect((screen.getByLabelText("Primeiro") as HTMLInputElement).value).toBe("abc");
    expect((screen.getByLabelText("Segundo") as HTMLInputElement).value).toBe("");
    expect(document.activeElement).toBe(screen.getByLabelText("Primeiro"));
  });
});
