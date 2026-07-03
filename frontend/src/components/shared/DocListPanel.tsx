"use client";

import { Button } from "@/components/ui/button";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

interface DocListPanelProps {
  collapsed: boolean;
  onToggle: () => void;
  headerLabel: string;
  isEmpty: boolean;
  children: React.ReactNode;
}

export function DocListPanel({
  collapsed,
  onToggle,
  headerLabel,
  isEmpty,
  children,
}: DocListPanelProps) {
  if (collapsed) {
    return (
      <div className="flex h-full w-9 shrink-0 flex-col items-center border-r bg-muted/20 py-2">
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={onToggle}
          title="Mostrar lista de documentos"
          aria-label="Mostrar lista de documentos"
        >
          <PanelLeftOpen className="size-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full w-64 shrink-0 flex-col border-r bg-muted/20">
      <div className="flex h-10 items-center justify-between border-b px-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {headerLabel}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={onToggle}
          title="Recolher lista"
          aria-label="Recolher lista"
        >
          <PanelLeftClose className="size-3.5" />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {isEmpty ? (
          <p className="p-3 text-xs text-muted-foreground">
            Nenhum documento na fila.
          </p>
        ) : (
          <ul className="divide-y">{children}</ul>
        )}
      </div>
    </div>
  );
}
