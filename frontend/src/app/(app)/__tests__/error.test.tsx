import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import AppError from "../error";
import { maskedServerError } from "@/test-utils/masked-server-error";

describe("(app)/error (#653)", () => {
  it("mostra, dentro do layout raiz, o código que bate com a linha do log", () => {
    const html = renderToStaticMarkup(
      <AppError error={maskedServerError()} retry={() => {}} />,
    );
    // Boundary de segmento, não o `global-error`: não redeclara o documento.
    expect(html).not.toContain("<html");
    expect(html).toContain("Algo deu errado");
    expect(html).toContain("Código do erro: 1bkm1w6");
    expect(html).toContain("Tentar de novo");
    expect(html).toContain('href="/dashboard"');
    expect(html).not.toContain("Server Components render");
  });

  it("sem digest (erro do navegador) mostra a mensagem e não inventa código", () => {
    const html = renderToStaticMarkup(
      <AppError error={new Error("falha no cliente")} retry={() => {}} />,
    );
    expect(html).toContain("falha no cliente");
    expect(html).not.toContain("Código do erro");
  });
});
