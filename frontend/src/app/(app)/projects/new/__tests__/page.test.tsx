// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { AUTOMATION_MODES } from "@/lib/types";

vi.mock("@/actions/projects", () => ({ createProject: vi.fn() }));

import NewProjectPage from "../page";

afterEach(cleanup);

describe("NewProjectPage — modo de automação padrão", () => {
  it("abre em 'none': é o valor que o form envia à Server Action", () => {
    const { container } = render(<NewProjectPage />);
    const hidden = container.querySelector<HTMLInputElement>(
      'input[type="hidden"][name="automation_mode"]',
    );
    expect(hidden?.value).toBe("none");
  });

  it("mostra a descrição do modo 'none' da fonte única", () => {
    render(<NewProjectPage />);
    const none = AUTOMATION_MODES.find((m) => m.value === "none");
    expect(none).toBeDefined();
    expect(
      screen.getByText((text) => text.startsWith(none!.description)),
    ).toBeTruthy();
  });
});
