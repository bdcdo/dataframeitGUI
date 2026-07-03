"use client";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useUrlState } from "@/hooks/useUrlState";

/**
 * Alterna a fila de Comparação entre "Meus atribuídos" (padrão) e "Todos" —
 * só renderizado para coordenador (gate no caller). "Meus" é o valor
 * ausente/default na URL para manter o link limpo; "Todos" só é alcançado
 * com `?queue=all` explícito, mesmo padrão de RoundSelect (CodingHeader).
 */
export function CompareQueueTabs() {
  const { get, set } = useUrlState();
  const queue = get("queue") === "all" ? "all" : "mine";

  return (
    <Tabs
      value={queue}
      onValueChange={(v) => set({ queue: v === "all" ? "all" : null })}
    >
      <TabsList className="h-7">
        <TabsTrigger value="mine" className="h-6 text-xs">
          Meus atribuídos
        </TabsTrigger>
        <TabsTrigger value="all" className="h-6 text-xs">
          Todos
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
