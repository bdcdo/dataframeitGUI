export const TYPE_LABELS: Record<string, string> = {
  single: "Escolha única",
  multi: "Múltipla escolha",
  text: "Texto livre",
  date: "Data",
};

export const TYPE_COLORS: Record<string, string> = {
  single: "bg-blue-500/10 text-blue-700",
  multi: "bg-purple-500/10 text-purple-700",
  text: "bg-green-500/10 text-green-700",
  date: "bg-amber-500/10 text-amber-700",
};

export function formatVerdictLabel(verdict: string): string {
  if (verdict === "nota") return "Nota do pesquisador";
  if (verdict === "anotacao") return "Anotação";
  if (verdict === "dificuldade") return "Dificuldade do LLM";
  if (verdict === "sugestao") return "Sugestão";
  if (verdict === "exclusao") return "Sugestão de exclusão";
  if (verdict === "duvida") return "Dúvida do gabarito";
  if (verdict === "ambiguo") return "Ambíguo";
  if (verdict === "pular") return "Pular";
  if (verdict.startsWith("{")) {
    try {
      const parsed = JSON.parse(verdict) as Record<string, boolean>;
      const selected = Object.entries(parsed)
        .filter(([, v]) => v)
        .map(([k]) => k);
      return selected.length > 0 ? selected.join(", ") : "(nenhuma)";
    } catch {
      /* fallback */
    }
  }
  return verdict;
}

export function verdictVariant(
  verdict: string,
): "default" | "secondary" | "destructive" | "outline" {
  if (verdict === "nota") return "secondary";
  if (verdict === "anotacao") return "secondary";
  if (verdict === "dificuldade") return "secondary";
  if (verdict === "sugestao") return "outline";
  if (verdict === "exclusao") return "destructive";
  if (verdict === "duvida") return "secondary";
  if (verdict === "ambiguo") return "secondary";
  if (verdict === "pular") return "outline";
  return "default";
}

export function formatAnswer(answer: unknown): string {
  if (answer === null || answer === undefined) return "(sem resposta)";
  if (Array.isArray(answer)) return answer.join(", ");
  return String(answer);
}
