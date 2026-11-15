import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../globals.css", () => ({}));

import GlobalError from "../global-error";
import { maskedServerError } from "@/test-utils/masked-server-error";

describe("global-error (#653)", () => {
  it("mostra em pt-BR o código que bate com a linha do log do servidor", () => {
    const html = renderToStaticMarkup(
      <GlobalError error={maskedServerError()} retry={() => {}} />,
    );
    expect(html).toContain('<html lang="pt-BR">');
    expect(html).toContain("Algo deu errado");
    expect(html).toContain("1bkm1w6");
    expect(html).toContain("Tentar de novo");
    expect(html).not.toContain("Server Components render");
  });

  it("sem digest (erro do navegador) mostra a mensagem e não inventa código", () => {
    const html = renderToStaticMarkup(
      <GlobalError error={new Error("falha no cliente")} retry={() => {}} />,
    );
    expect(html).toContain("Algo deu errado");
    expect(html).toContain("falha no cliente");
    expect(html).not.toContain("Código do erro");
  });
});
