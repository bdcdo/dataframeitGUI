"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { X } from "lucide-react";
import { DocPager } from "@/components/shared/DocPager";

interface FullscreenNavProps {
  title: string;
  currentIndex?: number;
  total?: number;
  onNavigate?: (index: number) => void;
  responseCount?: number;
  onExit: () => void;
}

export function FullscreenNav({
  title,
  currentIndex,
  total,
  onNavigate,
  responseCount,
  onExit,
}: FullscreenNavProps) {
  const hasNavigation = currentIndex !== undefined && total !== undefined && onNavigate;

  return (
    <div className="flex h-10 items-center justify-between border-b px-4 text-sm shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={onExit}
          title="Sair da tela cheia"
        >
          <X className="size-4" />
        </Button>
        <span className="truncate font-medium">{title}</span>
        {responseCount !== undefined && (
          <Badge variant="secondary" className="shrink-0">
            {responseCount} {responseCount === 1 ? "resposta" : "respostas"}
          </Badge>
        )}
      </div>
      {hasNavigation && (
        <DocPager
          index={currentIndex}
          total={total}
          onNavigate={onNavigate}
          buttonClassName="size-7"
        />
      )}
    </div>
  );
}
