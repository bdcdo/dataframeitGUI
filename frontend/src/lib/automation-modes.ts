// Contrato único dos modos de automação: tipo, metadados, disponibilidade e
// defaults precisam mudar juntos para que UI e Server Actions não divirjam.
export const AUTOMATION_MODES = [
  {
    value: "none",
    label: "Nenhuma automação",
    description:
      "Sem revisão automática. Qualquer comparação ou revisão é criada manualmente pelo coordenador.",
    requiresLlm: false,
  },
  {
    value: "auto_review_llm",
    label: "Auto-revisão vs LLM",
    description:
      "Quando uma pessoa termina de codificar e diverge do LLM, ela mesma revisa os campos divergentes; contestados vão para arbitragem.",
    requiresLlm: true,
  },
  {
    value: "compare_humans",
    label: "Comparação humano-vs-humano",
    description:
      "Quando duas pessoas codificam o mesmo documento e divergem, um revisor é sorteado para comparar as codificações.",
    requiresLlm: false,
  },
  {
    value: "compare_llm",
    label: "Comparação pessoa-vs-LLM",
    description:
      "Quando uma pessoa codifica e diverge do LLM, um revisor é sorteado para comparar a codificação humana contra a do LLM.",
    requiresLlm: true,
  },
] as const;

export type AutomationMode = (typeof AUTOMATION_MODES)[number]["value"];
export type AutomationModeOption = (typeof AUTOMATION_MODES)[number];

const AUTOMATION_MODE_VALUES = new Set<AutomationMode>(
  AUTOMATION_MODES.map(({ value }) => value),
);

export function isAutomationMode(value: unknown): value is AutomationMode {
  return (
    typeof value === "string" &&
    AUTOMATION_MODE_VALUES.has(value as AutomationMode)
  );
}

export function getAutomationModeOption(
  mode: AutomationMode,
): AutomationModeOption {
  return AUTOMATION_MODES.find(({ value }) => value === mode)!;
}

export function automationModeRequiresLlm(mode: AutomationMode): boolean {
  return getAutomationModeOption(mode).requiresLlm;
}

export function isAutomationModeAvailable(
  mode: AutomationMode,
  llmEnabled: boolean,
): boolean {
  return llmEnabled || !automationModeRequiresLlm(mode);
}

export function getAvailableAutomationModes(
  llmEnabled: boolean,
): ReadonlyArray<AutomationModeOption> {
  return llmEnabled
    ? AUTOMATION_MODES
    : AUTOMATION_MODES.filter(({ value }) =>
        isAutomationModeAvailable(value, llmEnabled),
      );
}

export function getDefaultAutomationMode(
  llmEnabled: boolean,
): AutomationMode {
  return llmEnabled ? "auto_review_llm" : "none";
}
