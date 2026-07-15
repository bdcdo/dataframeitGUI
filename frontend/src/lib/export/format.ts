// Formatação de valores para o export (CSV/XLSX), extraída de
// reviews/export/page.tsx como funções puras testáveis (feature 004).

// Converte qualquer valor de `answers` do schema em uma célula de texto:
// array → itens juntos por "; "; objeto (subfields) → "chave: valor" ignorando
// entradas vazias; null/undefined → "". Preserva o comportamento histórico.
export function formatExportValue(val: unknown): string {
  if (val == null) return "";
  if (typeof val === "string") return val;
  if (Array.isArray(val)) return val.join("; ");
  if (typeof val === "object") {
    return Object.entries(val as Record<string, unknown>)
      .filter(([, v]) => v != null && String(v).trim() !== "")
      .map(([k, v]) => `${k}: ${v}`)
      .join("; ");
  }
  return String(val);
}

// Formata o veredicto do revisor para exibição no gabarito: os sentinelas
// `ambiguo`/`pular` viram rótulos entre colchetes; um veredicto multi é gravado
// como JSON de flags booleanas ({opcao: true}) e vira a lista das selecionadas.
// JSON malformado mantém o valor cru (fail-soft, como no comportamento original).
export function formatVerdict(raw: string): string {
  if (raw === "ambiguo") return "[AMBIGUO]";
  if (raw === "pular") return "[PULAR]";
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, boolean>;
      return Object.entries(parsed)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join("; ");
    } catch {
      return raw;
    }
  }
  return raw;
}
