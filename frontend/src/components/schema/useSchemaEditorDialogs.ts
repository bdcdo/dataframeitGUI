"use client";

import { useState } from "react";

const VERSIONING_HELP_KEY = "schema-versioning-help-dismissed";

// Agrupa as flags de UI (dialogs de MAJOR/backfill e o banner de ajuda de
// versionamento) num hook co-localizado. Pura relocação de estado para manter
// o componente abaixo do limiar de useState do react-doctor — sem mudança de
// comportamento. O lazy initializer de `helpDismissed` lê o localStorage uma
// única vez na montagem e é preservado exatamente.
export function useSchemaEditorDialogs() {
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
    majorDialogOpen,
    setMajorDialogOpen,
    backfillDialogOpen,
    setBackfillDialogOpen,
    helpDismissed,
    dismissHelp,
  };
}
