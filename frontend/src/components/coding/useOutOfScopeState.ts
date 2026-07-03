import { useState } from "react";
import type { OutOfScopeState } from "./OutOfScopeToggle";

/** Config da pergunta "fora do escopo" no topo do painel. O estado vivo fica
 *  em estado local do painel (semeado daqui) — o painel é keyed por docId nas
 *  duas views, então reseta sozinho na troca de documento. */
export interface OutOfScopeConfig {
  projectId: string;
  documentId: string;
  documentTitle?: string;
  initialState: OutOfScopeState;
}

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
