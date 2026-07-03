"use client";

import { resolveDocTitle } from "@/lib/utils";
import { DocListPanel } from "@/components/shared/DocListPanel";
import {
  DocListItem,
  DocListDoneIcon,
  DocListBadge,
} from "@/components/shared/DocListItem";

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
  return (
    <DocListPanel
      collapsed={collapsed}
      onToggle={onToggle}
      headerLabel="Fila de arbitragem"
    >
      {!collapsed &&
        docs.map((d, idx) => {
          const isDone = d.finalDecided === d.totalFields;
          const phase: "blind" | "reveal" =
            d.blindDecided === d.totalFields ? "reveal" : "blind";
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
                variant={phase === "reveal" ? "secondary" : "outline"}
                title={
                  phase === "reveal"
                    ? "fase cega concluída — aguarda decisão final"
                    : "ainda na fase cega"
                }
              >
                {phase === "reveal" ? "Revelação" : "Cega"}
              </DocListBadge>
              <DocListBadge variant="outline" title="campos finalizados / total">
                {d.finalDecided}/{d.totalFields} ✓
              </DocListBadge>
            </DocListItem>
          );
        })}
    </DocListPanel>
  );
}
