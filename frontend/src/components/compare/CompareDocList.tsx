"use client";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Circle, PanelLeftClose, PanelLeftOpen } from "lucide-react";

export interface DocListEntry {
  id: string;
  title: string | null;
  external_id: string | null;
  humanCount: number;
  totalCount: number;
  assignedCodingCount: number;
  humansFromAssigned: number;
  divergentCount: number;
  reviewedCount: number;
  assignmentStatus: "pendente" | "em_andamento" | "concluido" | null;
}

interface CompareDocListProps {
  docs: DocListEntry[];
  currentIndex: number;
  onSelect: (index: number) => void;
  collapsed: boolean;
  onToggle: () => void;
}

function StatusDot({ status }: { status: DocListEntry["assignmentStatus"] }) {
  if (status === "concluido") {
    return <CheckCircle2 className="h-3 w-3 text-green-600" />;
  }
  if (status === "em_andamento") {
    return <Circle className="h-3 w-3 fill-amber-500/30 text-amber-600" />;
  }
  return <Circle className="h-3 w-3 text-muted-foreground/50" />;
}

export function CompareDocList({
  docs,
  currentIndex,
  onSelect,
  collapsed,
  onToggle,
}: CompareDocListProps) {
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
          Fila de revisão
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
              const pending = d.divergentCount - d.reviewedCount;
              const title = d.title || d.external_id || d.id.slice(0, 8);
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
                      <StatusDot status={d.assignmentStatus} />
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
                        variant="outline"
                        className="h-4 gap-0.5 px-1 text-[10px] font-normal"
                        title="humanos atualizados / atribuídos"
                      >
                        👤 {d.humansFromAssigned}
                        {d.assignedCodingCount > 0 && `/${d.assignedCodingCount}`}
                      </Badge>
                      <Badge
                        variant="outline"
                        className="h-4 px-1 text-[10px] font-normal"
                        title="respostas totais"
                      >
                        {d.totalCount} resp.
                      </Badge>
                      <Badge
                        variant={pending > 0 ? "secondary" : "outline"}
                        className={cn(
                          "h-4 px-1 text-[10px] font-normal",
                          pending === 0 && "text-muted-foreground",
                        )}
                        title="revisados / divergentes"
                      >
                        {d.reviewedCount}/{d.divergentCount} ✓
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
