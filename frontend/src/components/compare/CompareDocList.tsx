"use client";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Circle } from "lucide-react";
import { DocListPanel } from "@/components/shared/DocListPanel";
import { DocListItem } from "@/components/shared/DocListItem";

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
    return <CheckCircle2 className="size-3 text-green-600" />;
  }
  if (status === "em_andamento") {
    return <Circle className="size-3 fill-amber-500/30 text-amber-600" />;
  }
  return <Circle className="size-3 text-muted-foreground/50" />;
}

export function CompareDocList({
  docs,
  currentIndex,
  onSelect,
  collapsed,
  onToggle,
}: CompareDocListProps) {
  return (
    <DocListPanel
      collapsed={collapsed}
      onToggle={onToggle}
      headerLabel="Fila de revisão"
      isEmpty={docs.length === 0}
    >
      {docs.map((d, idx) => {
        const pending = d.divergentCount - d.reviewedCount;
        const title = d.title || d.external_id || d.id.slice(0, 8);
        const isCurrent = idx === currentIndex;
        return (
          <DocListItem
            key={d.id}
            icon={<StatusDot status={d.assignmentStatus} />}
            title={title}
            isCurrent={isCurrent}
            onClick={() => onSelect(idx)}
          >
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
          </DocListItem>
        );
      })}
    </DocListPanel>
  );
}
