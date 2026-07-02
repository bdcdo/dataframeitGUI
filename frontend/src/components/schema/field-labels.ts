// Labels e cores dos tipos/destinos de campo, compartilhados entre o editor
// de schema (FieldCard) e o editor inline (EditFieldDialog).

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

export const TARGET_LABELS: Record<string, string> = {
  llm_only: "Apenas LLM",
  human_only: "Apenas humano",
  none: "Oculto",
};
