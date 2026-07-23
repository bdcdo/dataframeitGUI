// Prefixo gravado quando o pesquisador escolhe a opção "Outro" mas ainda não
// digitou o complemento de texto livre. Fonte única do prefixo, compartilhada
// entre o renderer de codificação (FieldRenderer), o cálculo de "respondido"
// (QuestionsPanel) e o gate de codificação completa (coding-completeness).
// Módulo puro/client-safe — sem React — para poder ser importado tanto em
// componentes 'use client' quanto em server actions e testes Vitest.
export const OTHER_PREFIX = "Outro: ";

export function isOtherValue(v: unknown): v is string {
  return typeof v === "string" && v.startsWith(OTHER_PREFIX);
}

// True quando o valor é exatamente o prefixo "Outro" sem complemento — ou seja,
// o pesquisador marcou "Outro" mas não digitou o texto livre. Conta como
// resposta incompleta.
export function isIncompleteOther(v: unknown): boolean {
  return isOtherValue(v) && v === OTHER_PREFIX;
}
