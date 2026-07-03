"use client";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { DocListPanel } from "@/components/shared/DocListPanel";
import { DocListItem, DocListDoneIcon } from "@/components/shared/DocListItem";

export interface AutoReviewDocListEntry {
  id: string;
  title: string | null;
  externalId: string | null;
  totalFields: number;
  pendingFields: number;
}

interface AutoReviewDocListProps {
  docs: AutoReviewDocListEntry[];
  currentIndex: number;
  onSelect: (index: number) => void;
  collapsed: boolean;
  onToggle: () => void;
}

export function AutoReviewDocList({
  docs,
  currentIndex,
  onSelect,
  collapsed,
  onToggle,
}: AutoReviewDocListProps) {
  return (
    <DocListPanel
      collapsed={collapsed}
      onToggle={onToggle}
      headerLabel="Fila de auto-revisão"
      isEmpty={docs.length === 0}
    >
      {docs.map((d, idx) => {
        const reviewed = d.totalFields - d.pendingFields;
        const isDone = d.pendingFields === 0;
        const title = d.title || d.externalId || d.id.slice(0, 8);
        const isCurrent = idx === currentIndex;
        return (
          <DocListItem
            key={d.id}
            icon={<DocListDoneIcon isDone={isDone} />}
            title={title}
            isCurrent={isCurrent}
            onClick={() => onSelect(idx)}
          >
            <Badge
              variant={isDone ? "outline" : "secondary"}
              className={cn(
                "h-4 px-1 text-[10px] font-normal",
                isDone && "text-muted-foreground",
              )}
              title="campos revisados / divergentes"
            >
              {reviewed}/{d.totalFields} ✓
            </Badge>
          </DocListItem>
        );
      })}
    </DocListPanel>
  );
}
