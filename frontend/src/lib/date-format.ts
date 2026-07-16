// Formatacao de data/hora para exibicao. Isomorfico: importavel tanto de
// Server Component quanto de client component.
//
// O `timeZone` explicito abaixo nao e decorativo. Sem ele, a formatacao resolve
// o fuso do runtime: o servidor (Fly) roda em UTC e o navegador do usuario em
// America/Sao_Paulo (-03). Uma data renderizada as 21h em Sao Paulo ja e o dia
// seguinte em UTC, entao o markup do SSR e o da hidratacao divergem — hydration
// mismatch, alem da data simplesmente errada para o usuario. Fixar o fuso torna
// a saida identica nos dois lados por construcao.
//
// O locale tambem e explicito pelo mesmo motivo (ICU do servidor != navegador).
//
// Os formatadores sao construidos uma vez no escopo do modulo, e nao a cada
// chamada: montar um `Intl.DateTimeFormat` e caro (regra `js-hoist-intl`).

export const APP_TIME_ZONE = "America/Sao_Paulo";

const APP_LOCALE = "pt-BR";

const DATE_FORMATTER = new Intl.DateTimeFormat(APP_LOCALE, {
  timeZone: APP_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat(APP_LOCALE, {
  timeZone: APP_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** dd/mm/aaaa */
export function formatDate(iso: string): string {
  return DATE_FORMATTER.format(new Date(iso));
}

/** dd/mm/aaaa, hh:mm */
export function formatDateTime(iso: string): string {
  return DATE_TIME_FORMATTER.format(new Date(iso));
}

/**
 * aaaa-mm-dd, para compor nome de arquivo (ordenavel lexicograficamente).
 * Deriva as partes via `formatToParts` em vez de fatiar `toISOString()`, que
 * responderia em UTC e dataria o arquivo com o dia seguinte a noite.
 */
export function formatDateForFilename(date: Date): string {
  const parts = DATE_FORMATTER.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
