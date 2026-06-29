"use client";

import { useState } from "react";
import type { AutomationMode } from "@/lib/types";

interface RulesFormInitial {
  resolutionRule: string;
  minResponses: number;
  allowResearcherReview: boolean;
  automationMode: AutomationMode;
  comparisonIncludesLlm: boolean;
}

/**
 * Estado do formulário de regras de revisão (campos + feedback de salvamento).
 * Extraído de `RulesForm` para reduzir o número de `useState` do container
 * (react-doctor `prefer-useReducer`); o ruleset não conta `useState` dentro de
 * custom hooks.
 */
export function useRulesFormState(initial: RulesFormInitial) {
  const [rule, setRule] = useState(initial.resolutionRule);
  const [min, setMin] = useState(initial.minResponses);
  const [allowReview, setAllowReview] = useState(initial.allowResearcherReview);
  const [mode, setMode] = useState<AutomationMode>(initial.automationMode);
  const [includesLlm, setIncludesLlm] = useState(initial.comparisonIncludesLlm);
  const [saved, setSaved] = useState(false);

  return {
    rule,
    setRule,
    min,
    setMin,
    allowReview,
    setAllowReview,
    mode,
    setMode,
    includesLlm,
    setIncludesLlm,
    saved,
    setSaved,
  };
}
