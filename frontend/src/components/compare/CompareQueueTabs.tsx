"use client";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type CompareQueueScope = "mine" | "all";

interface CompareQueueTabsProps {
  value: CompareQueueScope;
  onValueChange: (value: CompareQueueScope) => void;
}

/**
 * Alterna a fila de Comparação entre "Meus atribuídos" (padrão) e "Todos" —
 * só renderizado para coordenador (gate no caller). Controlado pelo pai
 * (ComparePage), que detém a leitura/escrita da URL via useUrlState — mesmo
 * padrão de CodingHeader (`mode`/`onModeChange` como props puras), em vez de
 * cada instância deste componente (é montado 2x) ler a URL por conta própria.
 */
export function CompareQueueTabs({ value, onValueChange }: CompareQueueTabsProps) {
  return (
    <Tabs value={value} onValueChange={(v) => onValueChange(v as CompareQueueScope)}>
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
