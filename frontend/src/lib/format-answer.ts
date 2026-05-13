// Formatação de valores de answers (jsonb) para exibição/log.
//
// Duas variantes intencionais:
//
//  - formatAnswerDisplay: renderiza para humanos na UI. Strings vazias e
//    arrays vazios viram "(vazio)"; strings comuns aparecem cruas (sem aspas);
//    arrays viram lista CSV simples.
//
//  - formatAnswerTechnical: renderiza para logs e mensagens textuais
//    (project_comments). Strings ganham aspas para deixar explícito que é
//    string; arrays ficam entre brackets; recursivo.
//
// Ambas as funções tratam null/undefined como "(vazio)".

export function formatAnswerDisplay(v: unknown): string {
  if (v === null || v === undefined) return "(vazio)";
  if (typeof v === "string") return v.length === 0 ? "(vazio)" : v;
  if (Array.isArray(v)) return v.length === 0 ? "(vazio)" : v.join(", ");
  return JSON.stringify(v);
}

export function formatAnswerTechnical(v: unknown): string {
  if (v === null || v === undefined) return "(vazio)";
  if (typeof v === "string") return `"${v}"`;
  if (Array.isArray(v))
    return `[${v.map((x) => formatAnswerTechnical(x)).join(", ")}]`;
  return JSON.stringify(v);
}
