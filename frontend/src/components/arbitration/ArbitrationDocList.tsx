"use client";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Circle, PanelLeftClose, PanelLeftOpen } from "lucide-react";

export interface ArbitrationDocListEntry {
  id: string;
  title: string | null;
  externalId: string | null;
  totalFields: number;
  blindDecided: number;
  finalDecided: number;
}

interface ArbitrationDocListProps {
  docs: ArbitrationDocListEntry[];
  currentIndex: number;
  onSelect: (index: number) => void;
  collapsed: boolean;
  onToggle: () => void;
}

export function ArbitrationDocList({
  docs,
  currentIndex,
  onSelect,
  collapsed,
  onToggle,
}: ArbitrationDocListProps) {
  if (collapsed) {
    return (
      <div className="flex h-full w-9 shrink-0 flex-col items-center border-r bg-muted/20 py-2">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onToggle}
          title="Mostrar lista de documentos"
        >
          <PanelLeftOpen className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full w-64 shrink-0 flex-col border-r bg-muted/20">
      <div className="flex h-10 items-center justify-between border-b px-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Fila de arbitragem
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={onToggle}
          title="Recolher lista"
        >
          <PanelLeftClose className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {docs.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">
            Nenhum documento na fila.
          </p>
        ) : (
          <ul className="divide-y">
            {docs.map((d, idx) => {
              const isDone = d.finalDecided === d.totalFields;
              const phase: "blind" | "reveal" =
                d.blindDecided === d.totalFields ? "reveal" : "blind";
              const title = d.title || d.externalId || d.id.slice(0, 8);
              const isCurrent = idx === currentIndex;
              return (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(idx)}
                    className={cn(
                      "flex w-full flex-col gap-0.5 px-3 py-2 text-left text-xs transition-colors hover:bg-muted/60",
                      isCurrent && "bg-brand/10 hover:bg-brand/15",
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      {isDone ? (
                        <CheckCircle2 className="h-3 w-3 text-green-600" />
                      ) : (
                        <Circle className="h-3 w-3 text-muted-foreground/50" />
                      )}
                      <span
                        className={cn(
                          "truncate font-medium",
                          isCurrent && "text-brand",
                        )}
                        title={title}
                      >
                        {title}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1 pl-4.5">
                      <Badge
                        variant={phase === "reveal" ? "secondary" : "outline"}
                        className="h-4 px-1 text-[10px] font-normal"
                        title={
                          phase === "reveal"
                            ? "fase cega concluída — aguarda decisão final"
                            : "ainda na fase cega"
                        }
                      >
                        {phase === "reveal" ? "Revelação" : "Cega"}
                      </Badge>
                      <Badge
                        variant="outline"
                        className="h-4 px-1 text-[10px] font-normal"
                        title="campos finalizados / total"
                      >
                        {d.finalDecided}/{d.totalFields} ✓
                      </Badge>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
