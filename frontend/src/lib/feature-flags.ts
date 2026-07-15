// NEXT_PUBLIC_* é embutida no bundle pelo Next durante o build. Só o valor
// explícito "false" desliga a feature; ausência preserva o comportamento
// histórico e mantém desenvolvimento/self-hosting compatíveis por default.
export function isLlmEnabled(): boolean {
  return process.env.NEXT_PUBLIC_LLM_ENABLED !== "false";
}
