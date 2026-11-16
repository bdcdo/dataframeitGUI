"use client";

import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { DocPager } from "@/components/shared/DocPager";

interface SplitViewNavBarProps {
  title: string;
  onBack: () => void;
  docIndex: number;
  docCount: number;
  onNavigate: (index: number) => void;
}

export function SplitViewNavBar({
  title,
  onBack,
  docIndex,
  docCount,
  onNavigate,
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
      <DocPager
        index={docIndex}
        total={docCount}
        onNavigate={onNavigate}
        buttonClassName="size-7"
      />
    </div>
  );
}
