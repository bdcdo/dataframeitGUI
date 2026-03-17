import type { PydanticField } from "@/lib/types";

export const LLM_AMBIGUITIES_FIELD: PydanticField = {
  name: "llm_ambiguidades",
  type: "text",
  options: null,
  description:
    "Registre ambiguidades e incertezas encontradas nas instruções fornecidas e dificuldades encontradas ao classificar as decisões deste documento.",
  target: "llm_only",
};
