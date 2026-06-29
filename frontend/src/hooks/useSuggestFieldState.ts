"use client";

import { useState } from "react";
import type { PydanticField } from "@/lib/types";

/**
 * Estado do formulário de sugestão de campo (descrição, instruções, opções,
 * motivo) com reset ao trocar de campo. Extraído de `SuggestFieldDialog` para
 * reduzir o número de `useState` do container (react-doctor `prefer-useReducer`);
 * o ruleset não conta `useState` dentro de custom hooks. O reset segue o padrão
 * oficial do React de ajustar estado durante o render ao mudar uma prop.
 */
export function useSuggestFieldState(
  fieldName: string,
  allFields: PydanticField[],
) {
  const field = allFields.find((f) => f.name === fieldName);
  const [description, setDescription] = useState(field?.description ?? "");
  const [helpText, setHelpText] = useState(field?.help_text ?? "");
  const [options, setOptions] = useState<string[]>(field?.options ?? []);
  const [reason, setReason] = useState("");

  const [prevFieldName, setPrevFieldName] = useState(fieldName);
  if (fieldName !== prevFieldName) {
    setPrevFieldName(fieldName);
    const f = allFields.find((ff) => ff.name === fieldName);
    setDescription(f?.description ?? "");
    setHelpText(f?.help_text ?? "");
    setOptions(f?.options ?? []);
    setReason("");
  }

  return {
    description,
    setDescription,
    helpText,
    setHelpText,
    options,
    setOptions,
    reason,
    setReason,
  };
}
