"use client";

import { Badge } from "@/components/ui/badge";
import { DocListPanel } from "@/components/shared/DocListPanel";
import { DocListItem, DocListDoneIcon } from "@/components/shared/DocListItem";

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
      isEmpty={docs.length === 0}
    >
      {docs.map((d, idx) => {
        const isDone = d.finalDecided === d.totalFields;
        const phase: "blind" | "reveal" =
          d.blindDecided === d.totalFields ? "reveal" : "blind";
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
          </DocListItem>
        );
      })}
    </DocListPanel>
  );
}
