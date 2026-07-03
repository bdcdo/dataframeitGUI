import { useEffect, useRef } from "react";
import { verdictRequiresJustification } from "@/lib/auto-review-decided";
import type { SelfVerdict } from "@/lib/types";

// Teclado global (1-4 = verdict, P/N = navegação) + auto-advance pós-decisão
// do AutoReviewFieldPanel. O painel remonta via `key={currentKey}` a cada
// (doc, campo), então o hook desmonta e remonta junto — cancelamento do
// timeout e reregistro do listener seguem a mesma semântica de antes da
// extração.
export function useAutoReviewKeyboard({
  readOnly,
  fieldIndex,
  totalFields,
  answered,
  onChoose,
  onFieldNavigate,
}: {
  readOnly: boolean;
  fieldIndex: number;
  totalFields: number;
  answered: boolean[];
  onChoose: (verdict: SelfVerdict) => void;
  onFieldNavigate: (index: number) => void;
}) {
  // Listener de teclado registra uma vez (por readOnly); callbacks frescos
  // chegam via ref para evitar reregistro a cada keystroke.
  const handlerRef = useRef({ onChoose, onFieldNavigate, fieldIndex, totalFields });
  useEffect(() => {
    handlerRef.current = { onChoose, onFieldNavigate, fieldIndex, totalFields };
  });

  // Auto-advance pós-decisão: armazena handle do timeout num ref para poder
  // cancelar se o usuário trocar de doc/campo antes do disparo (evita pular
  // índice em contexto desatualizado).
  const advanceTimeoutRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (advanceTimeoutRef.current !== null) {
        window.clearTimeout(advanceTimeoutRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (readOnly) return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA"))
        return;
      const { onChoose, onFieldNavigate, fieldIndex, totalFields } =
        handlerRef.current;
      if (e.key === "1") {
        e.preventDefault();
        onChoose("contesta_llm");
      } else if (e.key === "2") {
        e.preventDefault();
        onChoose("admite_erro");
      } else if (e.key === "3") {
        e.preventDefault();
        onChoose("equivalente");
      } else if (e.key === "4") {
        e.preventDefault();
        onChoose("ambiguo");
      } else if (e.key.toLowerCase() === "p") {
        e.preventDefault();
        if (fieldIndex > 0) onFieldNavigate(fieldIndex - 1);
      } else if (e.key.toLowerCase() === "n") {
        e.preventDefault();
        if (fieldIndex < totalFields - 1) onFieldNavigate(fieldIndex + 1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [readOnly]);

  function handleChoose(v: SelfVerdict) {
    onChoose(v);
    // contesta_llm e ambiguo exigem justificativa: não auto-avança, senão o
    // pesquisador perderia o campo de texto que acabou de abrir.
    if (verdictRequiresJustification(v)) return;
    // Pula campos já respondidos no auto-advance pós-clique (P/N manuais
    // continuam navegando livremente para permitir re-conferência).
    const nextUnanswered = answered.findIndex((a, i) => i > fieldIndex && !a);
    if (nextUnanswered === -1) return;
    if (advanceTimeoutRef.current !== null) {
      window.clearTimeout(advanceTimeoutRef.current);
    }
    advanceTimeoutRef.current = window.setTimeout(() => {
      advanceTimeoutRef.current = null;
      onFieldNavigate(nextUnanswered);
    }, 250);
  }

  return { handleChoose };
}
