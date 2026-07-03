"use client";

import { cn, resolveDocTitle } from "@/lib/utils";
import { CheckCircle2, Circle } from "lucide-react";
import { DocListPanel } from "@/components/shared/DocListPanel";
import { DocListItem, DocListBadge } from "@/components/shared/DocListItem";

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
    >
      {!collapsed &&
        docs.map((d, idx) => {
          const pending = d.divergentCount - d.reviewedCount;
          const title = resolveDocTitle(d.title, d.external_id, d.id);
          const isCurrent = idx === currentIndex;
          return (
            <DocListItem
              key={d.id}
              icon={<StatusDot status={d.assignmentStatus} />}
              title={title}
              isCurrent={isCurrent}
              onClick={() => onSelect(idx)}
            >
              <DocListBadge
                variant="outline"
                className="gap-0.5"
                title="humanos atualizados / atribuídos"
              >
                👤 {d.humansFromAssigned}
                {d.assignedCodingCount > 0 && `/${d.assignedCodingCount}`}
              </DocListBadge>
              <DocListBadge variant="outline" title="respostas totais">
                {d.totalCount} resp.
              </DocListBadge>
              <DocListBadge
                variant={pending > 0 ? "secondary" : "outline"}
                className={cn(pending === 0 && "text-muted-foreground")}
                title="revisados / divergentes"
              >
                {d.reviewedCount}/{d.divergentCount} ✓
              </DocListBadge>
            </DocListItem>
          );
        })}
    </DocListPanel>
  );
}
