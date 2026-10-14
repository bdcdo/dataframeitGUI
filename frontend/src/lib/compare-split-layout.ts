// Divisão leitor/revisão da Comparação, persistida entre sessões (#610).
//
// Mora em COOKIE, e não em localStorage, porque o servidor precisa dela: o
// HTML tem de sair já na divisão salva. Com localStorage o servidor renderizava
// a divisão padrão e o cliente hidratava com a salva; o React 19 não corrige
// atributo divergente na hidratação, e o painel ficava preso no estilo do
// servidor até a pessoa arrastar o divisor de novo.
//
// Módulo puro, sem `next/headers` nem `document`: a página (RSC), o componente
// e o e2e importam daqui o nome do cookie e a validação.

/** `id` de cada painel: são as chaves do layout salvo. */
export const READER_PANEL_ID = "compare-reader";
export const REVIEW_PANEL_ID = "compare-review";

export const COMPARE_SPLIT_COOKIE = "compare-split";

/**
 * Onde o `useDefaultLayout` da react-resizable-panels gravava a divisão antes
 * do cookie. O formato da chave é da lib (`react-resizable-panels:` + id do
 * grupo + ids dos painéis, unidos por `:`); só é lido para migrar quem salvou
 * uma divisão naquela época, e apagado em seguida.
 */
export const LEGACY_SPLIT_STORAGE_KEY = `react-resizable-panels:compare:split:${READER_PANEL_ID}:${REVIEW_PANEL_ID}`;

export type SplitLayout = Record<
  typeof READER_PANEL_ID | typeof REVIEW_PANEL_ID,
  number
>;

/**
 * Valida um layout serializado (o JSON que a lib entrega em `onLayoutChanged`,
 * em percentuais 0..100) e devolve só as duas chaves conhecidas, ou `null`.
 *
 * Fail-closed porque o valor chega de cookie, que a pessoa pode editar: um
 * layout inválido entregue à lib como `defaultLayout` estouraria no render do
 * servidor ou desenharia painéis de largura absurda. Aceita o texto já
 * decodificado ou ainda em percent-encoding, porque quem decodifica o cookie
 * varia entre o `cookies()` do Next e `document.cookie`.
 */
export function parseSplitLayout(
  raw: string | null | undefined,
): SplitLayout | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const reader = record[READER_PANEL_ID];
  const review = record[REVIEW_PANEL_ID];
  if (!isPercent(reader) || !isPercent(review)) return null;
  // A lib normaliza para somar 100 com até 3 casas; folga de 1 ponto absorve
  // arredondamento sem aceitar um par que desenharia 120% de largura.
  if (Math.abs(reader + review - 100) > 1) return null;
  return { [READER_PANEL_ID]: reader, [REVIEW_PANEL_ID]: review };
}

function isPercent(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
  );
}

/** Um ano: a divisão é preferência de ergonomia, não de sessão. */
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** Linha de `document.cookie` que grava `layout`. */
export function splitLayoutCookie(layout: SplitLayout): string {
  const value = encodeURIComponent(JSON.stringify(layout));
  return `${COMPARE_SPLIT_COOKIE}=${value}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; samesite=lax`;
}
