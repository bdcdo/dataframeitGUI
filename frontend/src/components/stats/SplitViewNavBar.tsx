"use client";

import { Button } from "@/components/ui/button";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";

interface SplitViewNavBarProps {
  title: string;
  onBack: () => void;
  docIndex: number;
  docCount: number;
  onPrev: () => void;
  onNext: () => void;
}

export function SplitViewNavBar({
  title,
  onBack,
  docIndex,
  docCount,
  onPrev,
  onNext,
}: SplitViewNavBarProps) {
  return (
    <div className="flex items-center justify-between border-b px-4 py-2">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1">
          <ArrowLeft className="size-3.5" />
          Voltar à lista
        </Button>
        <span className="text-sm text-muted-foreground">{title}</span>
      </div>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          disabled={docIndex === 0}
          onClick={onPrev}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <span className="text-xs text-muted-foreground">
          {docIndex + 1}/{docCount}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          disabled={docIndex === docCount - 1}
          onClick={onNext}
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}
