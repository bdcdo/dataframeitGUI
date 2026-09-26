import { formatPartialDate } from "@/lib/date-parts";

// Exibição "crua" de um veredito: payload JSON de campo multi
// (`{opcao: boolean}`) vira a lista das opções marcadas separada por ", "
// (ou "(nenhuma)"); qualquer outro veredito é exibido como está, sem traduzir
// os marcadores ambiguo/pular.
//
// Variante intencionalmente distinta de `formatVerdictDisplay` em
// `@/lib/reviews/verdict-format` (fluxo Meus Vereditos/gabarito: join "; ",
// traduz ambiguo/pular e recebe fieldType) — ver o header daquele módulo
// sobre o mapa de variantes do codebase.
export function formatVerdictDisplay(verdict: string): string {
  if (verdict.startsWith("{")) {
    try {
      const parsed = JSON.parse(verdict) as Record<string, boolean>;
      const selected = Object.entries(parsed)
        .filter(([, v]) => v)
        .map(([k]) => k);
      return selected.length > 0 ? selected.join(", ") : "(nenhuma)";
    } catch {
      // fallback
    }
  }
  return verdict;
}

/**
 * O texto que o card de resposta da Comparação exibe, e que o voto no card
 * grava como veredito (`AgreementGroup`, e `confirmEquivalentVerdict` pelo
 * mesmo `displayAnswer`). Quem compara uma resposta crua com o veredito de um
 * voto em card precisa desta forma: a data parcial vira "—", e subcampos e
 * listas são unidos por ", ".
 */
export function formatCardAnswer(answer: unknown): string {
  if (answer == null) return "";
  if (typeof answer === "string") return formatPartialDate(answer.trim());
  if (Array.isArray(answer))
    return answer.map((v) => (typeof v === "string" ? v.trim() : v)).join(", ");
  if (typeof answer === "object") {
    const obj = answer as Record<string, unknown>;
    return Object.entries(obj)
      .filter(([, v]) => v != null && String(v).trim() !== "")
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
  }
  return String(answer);
}
