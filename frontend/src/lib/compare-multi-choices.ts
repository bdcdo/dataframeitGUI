// Lógica pura de pré-preenchimento das escolhas do MultiOptionReview.
// Vive em lib/ (e não no componente) para que o arquivo de componente só
// exporte componentes — requisito do Fast Refresh — e para ser testável
// isoladamente, junto dos demais utilitários puros de comparação.

function parseExistingMultiVerdict(
  verdict: string | undefined,
): Record<string, boolean> | null {
  if (!verdict || !verdict.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(verdict);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, boolean>;
    }
  } catch {
    // legacy string verdict — ignore
  }
  return null;
}

// Escolhas iniciais: verdict existente, senão segue a maioria por opção.
export function computeInitialChoices(
  verdict: string | undefined,
  optionStats: { option: string; selectedCount: number; totalRespondents: number }[],
): Record<string, boolean> {
  const existing = parseExistingMultiVerdict(verdict);
  if (existing) return existing;
  const result: Record<string, boolean> = {};
  for (const stat of optionStats) {
    result[stat.option] = stat.selectedCount > stat.totalRespondents / 2;
  }
  return result;
}
