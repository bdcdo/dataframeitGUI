import type { PydanticField } from "@/lib/types";

// Definição sem `id` de propósito: identidade nasce quando o campo entra no
// schema de UM projeto (`toggleLlmField` gera o UUID no append). Um id fixo
// aqui poderia colidir com um campo já existente que nasceu desta definição e
// foi renomeado.
export const LLM_AMBIGUITIES_FIELD: Omit<PydanticField, "id"> = {
  name: "llm_ambiguidades",
  type: "text",
  options: null,
  description:
    "Registre ambiguidades e incertezas encontradas nas instruções fornecidas e dificuldades encontradas ao classificar as decisões deste documento.",
  target: "llm_only",
};
