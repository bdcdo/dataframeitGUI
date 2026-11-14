"use client";

import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DocPager } from "@/components/shared/DocPager";
import type { AutoReviewQueueOwner } from "./AutoReviewPage";

interface AutoReviewPageHeaderProps {
  readOnly: boolean;
  reviewerLabel: string;
  isCoordinator: boolean;
  reviewers: AutoReviewQueueOwner[];
  queueUserId: string;
  ownQueueUserId: string;
  onViewAsChange: (userId: string) => void;
  docsCount: number;
  docIndex: number;
  onNavigate: (index: number) => void;
}

export function AutoReviewPageHeader({
  readOnly,
  reviewerLabel,
  isCoordinator,
  reviewers,
  queueUserId,
  ownQueueUserId,
  onViewAsChange,
  docsCount,
  docIndex,
  onNavigate,
}: AutoReviewPageHeaderProps) {
  return (
    <div className="flex h-10 shrink-0 items-center justify-between border-b px-4 text-sm">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-medium">Auto-revisão humano vs LLM</span>
        {readOnly ? (
          <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
            visualizando {reviewerLabel}
          </Badge>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {isCoordinator && reviewers.length > 1 ? (
          <Select value={queueUserId} onValueChange={onViewAsChange}>
            <SelectTrigger className="h-7 w-[200px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {reviewers.map((r) => (
                <SelectItem key={r.userId} value={r.userId} className="text-xs">
                  {r.name || r.email || r.userId.slice(0, 8)}
                  {r.userId === ownQueueUserId ? " (você)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <Badge variant="secondary" className="text-xs">
          {docsCount} doc{docsCount === 1 ? "" : "s"}
        </Badge>
        <DocPager index={docIndex} total={docsCount} onNavigate={onNavigate} />
      </div>
    </div>
  );
}
