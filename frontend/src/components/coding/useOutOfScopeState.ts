import { useState } from "react";
import type { OutOfScopeState } from "./OutOfScopeToggle";
import type { OutOfScopeConfig } from "./QuestionsPanel";

/**
 * Estado vivo da sinalização "fora do escopo", semeado uma vez do server
 * (capture-once; o painel é keyed por docId, então remonta a cada doc).
 */
export function useOutOfScopeState(outOfScope?: OutOfScopeConfig): {
  outOfScopeState: OutOfScopeState;
  setOutOfScopeState: (next: OutOfScopeState) => void;
  outOfScopeBlocked: boolean;
} {
  const [outOfScopeState, setOutOfScopeState] = useState<OutOfScopeState>(
    () => outOfScope?.initialState ?? { status: "normal" },
  );
  const outOfScopeBlocked = !!outOfScope && outOfScopeState.status !== "normal";

  return { outOfScopeState, setOutOfScopeState, outOfScopeBlocked };
}
