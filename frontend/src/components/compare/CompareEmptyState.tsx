"use client";

import type { ReactNode } from "react";
import { CompareDocList, type DocListEntry } from "./CompareDocList";

interface CompareEmptyStateProps {
  // Barras de topo compartilhadas com a visão completa, montadas no container.
  queueTabsBar: ReactNode;
  readOnlyNotice: ReactNode;
  docListEntries: DocListEntry[];
  docIndex: number;
  onSelect: (index: number) => void;
  listCollapsed: boolean;
  onToggleList: () => void;
  emptyMessage: string;
}

/**
 * Layout da Comparação quando não há documento/campo a exibir (fila vazia ou
 * sem divergência). Extraído de `ComparePage` na decomposição do container
 * (`no-giant-component`, #564): a sidebar continua navegável para o usuário
 * trocar de documento, com a mensagem centralizada resolvida no container.
 */
export function CompareEmptyState({
  queueTabsBar,
  readOnlyNotice,
  docListEntries,
  docIndex,
  onSelect,
  listCollapsed,
  onToggleList,
  emptyMessage,
}: CompareEmptyStateProps) {
  return (
    <div className="flex h-[calc(100vh-96px)] flex-col">
      {queueTabsBar}
      {readOnlyNotice}
      <div className="flex flex-1 w-full">
        <CompareDocList
          docs={docListEntries}
          currentIndex={docIndex}
          onSelect={onSelect}
          collapsed={listCollapsed}
          onToggle={onToggleList}
        />
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          {emptyMessage}
        </div>
      </div>
    </div>
  );
}
