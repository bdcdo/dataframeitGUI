"use client";

import { ChevronDown, ChevronRight } from "lucide-react";

/**
 * Chevron que expande/recolhe a justificativa de uma resposta. Compartilhado
 * por `GabaritoByDocument` e `VerdictsList`, que renderizam a mesma afordância
 * ao lado do nome do respondente.
 *
 * O rótulo acessível é obrigatório porque o botão é só o ícone: sem ele, um
 * leitor de tela anuncia apenas "botão". O `aria-expanded` completa o par —
 * é ele que informa em qual dos dois estados a divulgação está.
 */
export function JustificationToggle({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={expanded ? "Ocultar justificativa" : "Mostrar justificativa"}
      aria-expanded={expanded}
      onClick={onToggle}
      className="shrink-0 text-muted-foreground hover:text-foreground"
    >
      {expanded ? (
        <ChevronDown className="size-3.5" />
      ) : (
        <ChevronRight className="size-3.5" />
      )}
    </button>
  );
}
