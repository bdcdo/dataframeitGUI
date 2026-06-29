"use client";

import { useState } from "react";

const VERSIONING_HELP_KEY = "schema-versioning-help-dismissed";

/**
 * Estado de UI do editor de schema: erros de validação da GUI, os dois dialogs
 * (versão maior / backfill) e o dismiss persistido do banner de ajuda de
 * versionamento. Extraído de `SchemaEditor` para reduzir o número de `useState`
 * do container (react-doctor `prefer-useReducer`); o ruleset não conta `useState`
 * dentro de custom hooks. `mode`/`fields` permanecem no componente por serem o
 * estado de domínio do editor.
 */
export function useSchemaEditorUI() {
  const [guiErrors, setGuiErrors] = useState<string[]>([]);
  const [majorDialogOpen, setMajorDialogOpen] = useState(false);
  const [backfillDialogOpen, setBackfillDialogOpen] = useState(false);
  const [helpDismissed, setHelpDismissed] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(VERSIONING_HELP_KEY) === "1";
  });

  const dismissHelp = () => {
    setHelpDismissed(true);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(VERSIONING_HELP_KEY, "1");
    }
  };

  return {
    guiErrors,
    setGuiErrors,
    majorDialogOpen,
    setMajorDialogOpen,
    backfillDialogOpen,
    setBackfillDialogOpen,
    helpDismissed,
    dismissHelp,
  };
}
