import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import {
  hasOneParagraphPerLine,
  normalizeExtractedText,
} from "@/lib/document-text";

// O leitor passa o texto normalizado ao react-markdown; renderizar aqui é o que
// prova que não sai bloco de código nem lista onde o texto não os tem.
function render(text: string): string {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, null, normalizeExtractedText(text)),
  );
}

// Decisão antiga do portal do STF, que chega hard-wrapped e recuada como texto
// extraído de PDF.
const PDF_HARD_WRAPPED = [
  "DESPACHO: Trata-se de reclamação proposta pelo Município de Macaíba",
  "   (RN) contra ato do Juiz do Trabalho da 1ª Vara do Trabalho da",
  "   Cidade de Natal (RN) que, nos autos do processo nº 2022/01 (em",
  "   fase de execução), afastou a aplicação da lei nº 1.119/2003 do",
  "   Município requerente, porque o valor do limite está fixado na Carta",
  "   Magna, não podendo ser alterado por norma infra-",
  "   constitucional.",
  "",
  "   Decido.",
].join("\n");

// Decisão atual do portal do STF: um parágrafo por linha, recuo de quatro
// espaços e numeração dos itens.
const PORTAL_PARAGRAPH_PER_LINE = [
  "DECISÃO:",
  "    Trata-se de reclamação constitucional, com pedido liminar, ajuizada pelo Município contra decisão do TRT.",
  "    1. Narra a parte reclamante que a autoridade reclamada reconheceu a sua responsabilidade subsidiária.",
  "    2) Decido.",
  "    Publique-se. ",
].join("\r\n");

describe("hasOneParagraphPerLine", () => {
  it("linhas curtas que raramente terminam em pontuação são quebra dura", () => {
    expect(hasOneParagraphPerLine(PDF_HARD_WRAPPED.split("\n"))).toBe(false);
  });

  it("maioria das linhas terminando em pontuação é parágrafo por linha", () => {
    expect(hasOneParagraphPerLine(["DECISÃO:", "Cite-se.", "Publique-se.", "Relatora"])).toBe(true);
  });

  it("linhas longas são parágrafo por linha mesmo sem pontuação final", () => {
    const longLine = "palavra ".repeat(20);
    expect(hasOneParagraphPerLine([longLine, longLine, "curta"])).toBe(true);
  });

  it("uma linha só não decide nada", () => {
    expect(hasOneParagraphPerLine(["Decido."])).toBe(false);
  });
});

describe("normalizeExtractedText", () => {
  it("cola em parágrafos o texto de PDF com quebra dura, sem recuo nem hífen de fim de linha", () => {
    expect(normalizeExtractedText(PDF_HARD_WRAPPED)).toBe(
      "DESPACHO: Trata-se de reclamação proposta pelo Município de Macaíba (RN) contra ato do Juiz do Trabalho da 1ª Vara do Trabalho da Cidade de Natal (RN) que, nos autos do processo nº 2022/01 (em fase de execução), afastou a aplicação da lei nº 1.119/2003 do Município requerente, porque o valor do limite está fixado na Carta Magna, não podendo ser alterado por norma infraconstitucional.\n\nDecido.",
    );
    expect(render(PDF_HARD_WRAPPED)).not.toContain("<pre>");
  });

  it("linha só de espaços não separa parágrafo no texto com quebra dura", () => {
    const text = `${PDF_HARD_WRAPPED}\n1. Primeiro item da\n   lista.\n \n2. Segundo item da\n   lista.`;
    const html = render(text);
    expect(html.match(/<ol>/g)).toHaveLength(1);
    expect(html).toContain("<li>Primeiro item da lista.</li>");
    expect(html).toContain("<li>Segundo item da lista.</li>");
  });

  it("rende um parágrafo por linha no texto de portal, sem bloco de código nem lista", () => {
    expect(normalizeExtractedText(PORTAL_PARAGRAPH_PER_LINE)).toBe(
      [
        "DECISÃO:",
        "Trata-se de reclamação constitucional, com pedido liminar, ajuizada pelo Município contra decisão do TRT.",
        "1\\. Narra a parte reclamante que a autoridade reclamada reconheceu a sua responsabilidade subsidiária.",
        "2\\) Decido.",
        "Publique-se.",
      ].join("\n\n"),
    );
    const html = render(PORTAL_PARAGRAPH_PER_LINE);
    expect(html).not.toContain("<pre>");
    expect(html).not.toContain("<ol");
    expect(html).toContain("<p>1. Narra a parte reclamante");
    expect(html.match(/<p>/g)).toHaveLength(5);
  });

  it("escapa marcador de lista e de citação no texto de portal", () => {
    const text = "- Relator -\n> citação literal.\n+ item.\n* item.";
    expect(normalizeExtractedText(text)).toBe(
      "\\- Relator -\n\n\\> citação literal.\n\n\\+ item.\n\n\\* item.",
    );
    expect(render(text)).not.toMatch(/<(ul|blockquote)/);
  });

  it("não escapa o que não está no começo da linha nem o número sem espaço depois", () => {
    const text = "Rcl 1.234-MC, art. 5º, §1º; #123 não é título.\n2024/2025 e 1.5 ficam.";
    expect(normalizeExtractedText(text)).toBe(text.replace("\n", "\n\n"));
  });

  it("mantém título Markdown no texto que já é Markdown", () => {
    const text =
      "## CONCLUSÃO\nCONSIDERANDO o diagnóstico de neoplasia maligna.\n\n## EFICÁCIA\nO câncer de pulmão é comum.";
    expect(normalizeExtractedText(text)).toBe(
      "## CONCLUSÃO\n\nCONSIDERANDO o diagnóstico de neoplasia maligna.\n\n## EFICÁCIA\n\nO câncer de pulmão é comum.",
    );
    expect(render(text)).toContain("<h2>CONCLUSÃO</h2>");
  });

  it("colapsa o espaço repetido depois da numeração no texto Markdown", () => {
    const text = "## CONCLUSÃO\n1.                    Inicialmente, cumpre esclarecer.\n\n2.                     Trata-se de Autor.";
    const html = render(text);
    expect(html).not.toContain("<pre>");
    expect(html).toContain("<p>Inicialmente, cumpre esclarecer.</p>");
  });

  // O leitor não carrega plugin GFM, então a tabela chega ao react-markdown como
  // texto; o que se preserva é o bloco, linha a linha, com `$1` intacto.
  it("preserva a tabela Markdown no texto com quebra dura", () => {
    const table = "| Item | Valor $1 |\n|---|---|\n| a | 1 |";
    const text = `${PDF_HARD_WRAPPED}\nSegue a tabela\nde custos:\n${table}\nFim do\ndocumento.`;
    expect(normalizeExtractedText(text)).toContain(
      `Decido. Segue a tabela de custos:\n\n${table}\n\nFim do documento.`,
    );
  });

  it("preserva a tabela Markdown no texto com um parágrafo por linha", () => {
    const table = "| Item | Valor |\n|---|---|\n| a | 1 |";
    const text = `    Segue a tabela de custos:\n${table}\n    Fim do documento.`;
    expect(normalizeExtractedText(text)).toBe(
      `Segue a tabela de custos:\n\n${table}\n\nFim do documento.`,
    );
  });
});
