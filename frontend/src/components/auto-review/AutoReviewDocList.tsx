"use client";

import { cn, resolveDocTitle } from "@/lib/utils";
import { DocListPanel } from "@/components/shared/DocListPanel";
import {
  DocListItem,
  DocListDoneIcon,
  DocListBadge,
} from "@/components/shared/DocListItem";

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
    >
      {!collapsed &&
        docs.map((d, idx) => {
          const reviewed = d.totalFields - d.pendingFields;
          const isDone = d.pendingFields === 0;
          const title = resolveDocTitle(d.title, d.externalId, d.id);
          const isCurrent = idx === currentIndex;
          return (
            <DocListItem
              key={d.id}
              icon={<DocListDoneIcon isDone={isDone} />}
              title={title}
              isCurrent={isCurrent}
              onClick={() => onSelect(idx)}
            >
              <DocListBadge
                variant={isDone ? "outline" : "secondary"}
                className={cn(isDone && "text-muted-foreground")}
                title="campos revisados / divergentes"
              >
                {reviewed}/{d.totalFields} ✓
              </DocListBadge>
            </DocListItem>
          );
        })}
    </DocListPanel>
  );
}
