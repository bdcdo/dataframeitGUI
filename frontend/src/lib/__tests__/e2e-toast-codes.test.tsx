// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { Toaster, toast } from "sonner";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { errorCode, withErrorCode } from "@/lib/server-error";
import { warmUpJsdom } from "@/test-utils/jsdom-warm-up";
import { maskedServerError } from "@/test-utils/masked-server-error";
import { TOAST_CODE_PATTERN, watchToastCodes } from "../../../e2e/navigation-diagnostics";

// O observer que base-test.ts injeta na página, contra o `Toaster` real do
// sonner: se o sonner mudar a marcação do toast, o diagnóstico para de achar o
// código e este teste quebra.

beforeAll(() => warmUpJsdom(), 30_000);

// O observer de um teste segue vivo no documento do jsdom nos seguintes; cada
// teste usa um binding próprio, e o do anterior deixa de existir.
let binding = "";
let installs = 0;

function install() {
  binding = `__e2eToastCodeTest${++installs}`;
  const report = vi.fn();
  Object.assign(window, { [binding]: report });
  // Como o `addInitScript` do Playwright faz: o texto da função com o
  // argumento em JSON, sem o escopo do módulo.
  new Function(`(${watchToastCodes.toString()})(${JSON.stringify({ binding, pattern: TOAST_CODE_PATTERN })})`)();
  return report;
}

afterEach(() => {
  toast.dismiss();
  cleanup();
  Reflect.deleteProperty(window, binding);
});

describe("watchToastCodes", () => {
  it("manda só o código do toast de erro com a copy real", async () => {
    const report = install();
    render(<Toaster theme="light" />);
    const error = maskedServerError();
    act(() => {
      toast.error(withErrorCode(error, "Erro ao enviar dado-sigiloso@x.com"));
    });
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith(errorCode(error)));
    expect(report).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(report.mock.calls)).not.toContain("sigiloso");
  });

  it("acha o código seguido de texto e o da descrição", async () => {
    const report = install();
    render(<Toaster theme="light" />);
    act(() => {
      toast.error(`${withErrorCode(maskedServerError("1903308217"), "Erro")}. Tente de novo.`, {
        description: withErrorCode(maskedServerError("42424242"), "Detalhe"),
      });
    });
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2));
    expect(report.mock.calls.flat().sort()).toEqual(
      [errorCode(maskedServerError("1903308217")), errorCode(maskedServerError("42424242"))].sort(),
    );
  });

  it("toast sem código não manda nada", async () => {
    const report = install();
    render(<Toaster theme="light" />);
    act(() => {
      toast.error("Erro ao enviar");
      toast.success("Respostas salvas");
    });
    await vi.waitFor(() => expect(document.querySelectorAll("[data-sonner-toast]")).toHaveLength(2));
    expect(report).not.toHaveBeenCalled();
  });
});
