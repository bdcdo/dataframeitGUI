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
