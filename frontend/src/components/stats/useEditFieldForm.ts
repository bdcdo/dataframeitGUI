"use client";

import { useState, useTransition } from "react";
import { useResetOnKeyChange } from "@/hooks/useResetOnKeyChange";
import type { FieldCondition, PydanticField, SubfieldDef } from "@/lib/types";
import { resolveAllowOther, resolveSubfieldRule } from "@/lib/pydantic-field";

export interface PendingSuggestion {
  id: string;
  changes: {
    description?: string;
    help_text?: string | null;
    options?: string[] | null;
  };
}

interface FormSeed {
  description: string;
  helpText: string;
  options: string[];
}

function seedFromField(field: PydanticField | undefined): FormSeed {
  return {
    description: field?.description ?? "",
    helpText: field?.help_text ?? "",
    options: field?.options ?? [],
  };
}

// Distinguish "no change" (undefined) from "clear" (null) in suggestions:
// null in suggested_changes means the suggestion explicitly wants to empty
// the field, so ?? against the current field value would mask that intent.
function seedWithSuggestion(
  seed: FormSeed,
  ch: PendingSuggestion["changes"],
): FormSeed {
  return {
    description: ch.description ?? seed.description,
    helpText: ch.help_text !== undefined ? (ch.help_text ?? "") : seed.helpText,
    options: ch.options !== undefined ? (ch.options ?? []) : seed.options,
  };
}

function initialFromField(
  field: PydanticField | undefined,
  suggestion?: PendingSuggestion | null,
): FormSeed {
  const seed = seedFromField(field);
  return suggestion ? seedWithSuggestion(seed, suggestion.changes) : seed;
}

export function useEditFieldForm(
  fieldName: string,
  allFields: PydanticField[],
  pendingSuggestion?: PendingSuggestion | null,
) {
  // O form congela na abertura por design (um refresh RSC não pode apagar a
  // digitação), então o schema-base do qual ele foi semeado precisa congelar
  // JUNTO: é ele o "base" do merge de três vias no save e a referência de
  // exibição (descriptionChanged, opções removidas). Comparar o state do form
  // com o `allFields` vivo mistura dois instantes e foi o que deixou o save
  // sobrescrever edição concorrente em silêncio (#501).
  const [baseFields, setBaseFields] = useState(allFields);
  const baseField = baseFields.find((f) => f.name === fieldName);

  const initial = initialFromField(baseField, pendingSuggestion);
  const [description, setDescription] = useState(initial.description);
  const [helpText, setHelpText] = useState(initial.helpText);
  const [options, setOptions] = useState<string[]>(initial.options);
  const [allowOther, setAllowOther] = useState<boolean>(() =>
    resolveAllowOther(baseField?.allow_other),
  );
  const [subfields, setSubfields] = useState<SubfieldDef[] | undefined>(
    baseField?.subfields,
  );
  const [subfieldRule, setSubfieldRule] = useState(() =>
    resolveSubfieldRule(baseField?.subfield_rule),
  );
  const [condition, setCondition] = useState<FieldCondition | undefined>(
    baseField?.condition,
  );
  const [justificationPrompt, setJustificationPrompt] = useState<string>(
    baseField?.justification_prompt ?? "",
  );
  const [isSaving, startSave] = useTransition();

  // Reset state when dialog opens with a different field or suggestion
  const resetKey = `${fieldName}::${pendingSuggestion?.id ?? ""}`;
  useResetOnKeyChange(resetKey, () => {
    setBaseFields(allFields);
    const f = allFields.find((ff) => ff.name === fieldName);
    const init = initialFromField(f, pendingSuggestion);
    setDescription(init.description);
    setHelpText(init.helpText);
    setOptions(init.options);
    setAllowOther(resolveAllowOther(f?.allow_other));
    setSubfields(f?.subfields);
    setSubfieldRule(resolveSubfieldRule(f?.subfield_rule));
    setCondition(f?.condition);
    setJustificationPrompt(f?.justification_prompt ?? "");
  });

  return {
    baseFields,
    baseField,
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
