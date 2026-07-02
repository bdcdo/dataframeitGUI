"use client";

import { useState, useTransition } from "react";
import type { FieldCondition, PydanticField, SubfieldDef } from "@/lib/types";

export interface PendingSuggestion {
  id: string;
  changes: {
    description?: string;
    help_text?: string | null;
    options?: string[] | null;
  };
}

function initialFromField(
  field: PydanticField | undefined,
  suggestion?: PendingSuggestion | null,
) {
  const ch = suggestion?.changes ?? {};
  // Distinguish "no change" (undefined) from "clear" (null) in suggestions:
  // null in suggested_changes means the suggestion explicitly wants to empty
  // the field, so ?? against the current field value would mask that intent.
  return {
    description: ch.description ?? field?.description ?? "",
    helpText:
      ch.help_text !== undefined
        ? (ch.help_text ?? "")
        : (field?.help_text ?? ""),
    options:
      ch.options !== undefined
        ? (ch.options ?? [])
        : (field?.options ?? []),
  };
}

export function useEditFieldForm(
  field: PydanticField | undefined,
  fieldName: string,
  allFields: PydanticField[],
  pendingSuggestion?: PendingSuggestion | null,
) {
  const initial = initialFromField(field, pendingSuggestion);
  const [description, setDescription] = useState(initial.description);
  const [helpText, setHelpText] = useState(initial.helpText);
  const [options, setOptions] = useState<string[]>(initial.options);
  const [allowOther, setAllowOther] = useState<boolean>(field?.allow_other ?? false);
  const [subfields, setSubfields] = useState<SubfieldDef[] | undefined>(field?.subfields);
  const [subfieldRule, setSubfieldRule] = useState<"all" | "at_least_one">(field?.subfield_rule ?? "all");
  const [condition, setCondition] = useState<FieldCondition | undefined>(field?.condition);
  const [justificationPrompt, setJustificationPrompt] = useState<string>(
    field?.justification_prompt ?? "",
  );
  const [isSaving, startSave] = useTransition();

  // Reset state when dialog opens with a different field or suggestion
  const resetKey = `${fieldName}::${pendingSuggestion?.id ?? ""}`;
  // `prevKey` É lido no render (comparação `resetKey !== prevKey` abaixo) — é o
  // padrão oficial React de "adjusting state on a prop change", não state
  // só-de-handler. A regra classifica errado; useRef quebraria o padrão.
  // react-doctor-disable-next-line react-doctor/rerender-state-only-in-handlers
  const [prevKey, setPrevKey] = useState(resetKey);
  if (resetKey !== prevKey) {
    setPrevKey(resetKey);
    const f = allFields.find((ff) => ff.name === fieldName);
    const init = initialFromField(f, pendingSuggestion);
    setDescription(init.description);
    setHelpText(init.helpText);
    setOptions(init.options);
    setAllowOther(f?.allow_other ?? false);
    setSubfields(f?.subfields);
    setSubfieldRule(f?.subfield_rule ?? "all");
    setCondition(f?.condition);
    setJustificationPrompt(f?.justification_prompt ?? "");
  }

  return {
    description,
    setDescription,
    helpText,
    setHelpText,
    options,
    setOptions,
    allowOther,
    setAllowOther,
    subfields,
    setSubfields,
    subfieldRule,
    setSubfieldRule,
    condition,
    setCondition,
    justificationPrompt,
    setJustificationPrompt,
    isSaving,
    startSave,
  };
}
