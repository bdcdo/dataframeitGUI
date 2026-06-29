"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { AutoReviewQueueOwner } from "./AutoReviewPage";

interface AutoReviewPageHeaderProps {
  readOnly: boolean;
  reviewerLabel: string;
  isCoordinator: boolean;
  reviewers: AutoReviewQueueOwner[];
  viewAsUserId: string;
  currentUserId: string;
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
  viewAsUserId,
  currentUserId,
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
          <Select value={viewAsUserId} onValueChange={onViewAsChange}>
            <SelectTrigger className="h-7 w-[200px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {reviewers.map((r) => (
                <SelectItem key={r.userId} value={r.userId} className="text-xs">
                  {r.name || r.email || r.userId.slice(0, 8)}
                  {r.userId === currentUserId ? " (você)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <Badge variant="secondary" className="text-xs">
          {docsCount} doc{docsCount === 1 ? "" : "s"}
        </Badge>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={() => onNavigate(docIndex - 1)}
            disabled={docIndex === 0}
            title="Documento anterior"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span className="text-xs text-muted-foreground">
            {docIndex + 1}/{docsCount}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={() => onNavigate(docIndex + 1)}
            disabled={docIndex === docsCount - 1}
            title="Próximo documento"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
