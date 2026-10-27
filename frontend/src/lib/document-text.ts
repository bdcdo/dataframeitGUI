// Prepara o texto de um documento para o react-markdown do leitor de codificação.
//
// Dois formatos de texto chegam pelo CSV e pedem tratamentos opostos da quebra
// de linha simples. O texto extraído de PDF vem com quebra dura dentro do
// parágrafo: linhas de 50 a 80 caracteres, só a linha em branco separa
// parágrafos, e a quebra simples precisa virar espaço. O texto de portal de
// tribunal (o do STF, por exemplo) traz um parágrafo por linha, recuado com
// quatro espaços: colado, vira uma muralha de texto; recuado, o Markdown o mostra
// como bloco de código. A decisão é por documento, pela heurística de
// `hasOneParagraphPerLine`; o recuo e o espaço duro saem nos dois casos.

const TABLE_PLACEHOLDER = "\u0000TABLE\u0000";
const PARAGRAPH_PLACEHOLDER = "\u0000PARA\u0000";

// Linhas consecutivas que começam e terminam com `|`: o bloco sai inteiro antes
// de qualquer outra transformação, porque as quebras entre as linhas da tabela
// são a própria sintaxe dela.
const MARKDOWN_TABLE = /^(?:\|.*\|[ \t]*(?:\n|$))+/gm;
const MARKDOWN_HEADING = /^#{1,6} \S/;

// Fim de parágrafo em prosa jurídica: pontuação final, fecho de parêntese ou de
// citação. Uma linha de PDF termina onde a margem corta, e cai nessa classe
// só quando a frase acaba ali por coincidência.
const PARAGRAPH_END = /[.:;!?)»"”]$/;

// Medidas em 47 mil decisões monocráticas do STF (texto do portal, um parágrafo
// por linha) contra 298 PDFs dessas mesmas decisões extraídos com pypdf (quebra
// dura): a mediana do comprimento das linhas não vazias foi de 212 caracteres
// nos textos do portal (5º percentil 60, porque as decisões antigas do portal
// também vêm hard-wrapped) e no máximo 69 nos PDFs; a fração de linhas que
// terminam em pontuação foi de 0,89 no portal (5º percentil 0,74) e no máximo
// 0,32 nos PDFs. Os dois limiares ficam entre as duas populações, e a
// pontuação decide sozinha quando o texto é curto.
const MEDIAN_LINE_LENGTH_OF_PARAGRAPHS = 120;
const PARAGRAPH_END_SHARE = 0.5;

// Numeração de item ("1." e "2)") e marcador de lista ou citação no começo da
// linha, que o Markdown leria como sintaxe. O dígito não é escapável, então na
// numeração a barra vai antes do ponto ou do parêntese. O `#` de título não
// entra porque é ele que marca o texto como Markdown.
const NUMBERED_MARKER = /^(\d+)([.)])(?=\s|$)/;
const BLOCK_MARKER = /^[-*+>](?=\s|$)/;

export function hasOneParagraphPerLine(lines: readonly string[]): boolean {
  const nonEmpty = lines.filter(
    (line) => line.trim().length > 0 && line !== TABLE_PLACEHOLDER,
  );
  if (nonEmpty.length < 2) return false;
  const lengths = nonEmpty.map((line) => line.length).sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)];
  const endingInPunctuation = nonEmpty.filter((line) =>
    PARAGRAPH_END.test(line),
  ).length;
  return (
    median >= MEDIAN_LINE_LENGTH_OF_PARAGRAPHS ||
    endingInPunctuation / nonEmpty.length >= PARAGRAPH_END_SHARE
  );
}

// Cada linha vira um parágrafo. O texto de portal não é Markdown, então o que
// ele tem no começo da linha ("1. Trata-se", "- Relator -") aparece como foi
// escrito; o texto que já traz título ou tabela Markdown (saída de OCR, nota
// técnica) é Markdown e fica como está.
function paragraphPerLine(lines: readonly string[], isMarkdown: boolean) {
  return lines
    .filter((line) => line.trim().length > 0)
    .map((line) =>
      isMarkdown
        ? line
        : line.replace(NUMBERED_MARKER, "$1\\$2").replace(BLOCK_MARKER, "\\$&"),
    )
    .join("\n\n");
}

// Quebra simples vira espaço, hífen de fim de linha some, e só a linha em
// branco separa parágrafos. A quebra antes de marcador de lista ou citação
// fica, para a lista extraída do PDF continuar lista.
function joinHardWrappedLines(lines: readonly string[]) {
  return lines
    .join("\n")
    .replace(/\n{2,}/g, PARAGRAPH_PLACEHOLDER)
    .replace(/(\w)-\n(\w)/g, "$1$2")
    .replace(/\n(?![-*>]|\d+\.)/g, " ")
    .replaceAll(PARAGRAPH_PLACEHOLDER, "\n\n")
    .replace(/ {2,}/g, " ");
}

// Recuo e espaço repetido saem da linha: quatro espaços no começo são bloco de
// código em Markdown, e "1." seguido de vários espaços é item de lista com bloco
// de código dentro; nenhum dos formatos de texto os usa com esse sentido. A
// linha só de espaços fica com um espaço, para o modo de quebra dura não a ler
// como linha em branco: no texto de PDF ela aparece no meio do parágrafo, e
// uma quebra de parágrafo ali fecha a lista numerada que vinha antes.
function trimLine(line: string): string {
  const trimmed = line.trim().replace(/[ \t]{2,}/g, " ");
  return trimmed === "" && line !== "" ? " " : trimmed;
}

export function normalizeExtractedText(text: string): string {
  const tables: string[] = [];
  // A tabela vira parágrafo próprio para a quebra que a cerca não ser colada
  // no modo de quebra dura; o bloco casado leva a quebra final da última
  // linha, que a substituição repõe.
  const lines = text
    .replace(/\r\n?/g, "\n")
    .replaceAll(" ", " ")
    .replace(MARKDOWN_TABLE, (block) => {
      tables.push(block.trimEnd());
      return `\n${TABLE_PLACEHOLDER}\n\n`;
    })
    .split("\n")
    .map(trimLine);
  const isMarkdown =
    tables.length > 0 || lines.some((line) => MARKDOWN_HEADING.test(line));
  const body = hasOneParagraphPerLine(lines)
    ? paragraphPerLine(lines, isMarkdown)
    : joinHardWrappedLines(lines);
  // Replacer em função: o texto da tabela pode conter `$1`, que `replace` com
  // string leria como referência de grupo.
  return body.replaceAll(TABLE_PLACEHOLDER, () => tables.shift() ?? "").trim();
}
