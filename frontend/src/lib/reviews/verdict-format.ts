// Formatação de respostas e vereditos no fluxo "Meus Vereditos" / gabarito.
//
// Semântica própria deste fluxo, intencionalmente distinta das outras variantes
// do codebase — por isso NÃO são intercambiáveis:
//   - `formatAnswer` (@/lib/reviews/queries): null → "", objeto separado por
//     "; ", recursivo.
//   - `formatAnswerDisplay` (@/lib/format-answer): null/vazio → "(vazio)",
//     objeto via JSON.stringify.
// Aqui: null → "(sem resposta)", objeto "k: v" separado por ", ".

export function formatVerdictAnswer(answer: unknown): string {
  if (answer == null) return "(sem resposta)";
  if (typeof answer === "string") return answer;
  if (Array.isArray(answer)) return answer.join(", ");
  if (typeof answer === "object") {
    return Object.entries(answer as Record<string, unknown>)
      .flatMap(([k, v]) =>
        v != null && String(v).trim() !== "" ? [`${k}: ${v}`] : [],
      )
      .join(", ");
  }
  return String(answer);
}

export function formatVerdictDisplay(verdict: string, fieldType?: string): string {
  if (verdict === "ambiguo") return "Ambíguo";
  if (verdict === "pular") return "Pular";
  if (fieldType === "multi" || verdict.startsWith("{")) {
    try {
      const parsed = JSON.parse(verdict) as Record<string, boolean>;
      const selected = Object.entries(parsed).flatMap(([k, v]) =>
        v ? [k] : [],
      );
      return selected.length > 0 ? selected.join("; ") : "(nenhuma)";
    } catch {
      // fallback
    }
  }
  return verdict;
}
