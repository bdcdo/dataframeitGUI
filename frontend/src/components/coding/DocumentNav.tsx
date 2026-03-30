"use client";

import { Button } from "@/components/ui/button";
import { CopyLinkButton } from "@/components/ui/CopyLinkButton";
import { ChevronLeft, ChevronRight, Maximize2, MessageSquarePlus } from "lucide-react";

interface DocumentNavProps {
  title: string;
  currentIndex: number;
  total: number;
  onNavigate: (index: number) => void;
  onToggleFullscreen?: () => void;
  parecerUrl?: string;
  onDiscuss?: () => void;
}

export function DocumentNav({ title, currentIndex, total, onNavigate, onToggleFullscreen, parecerUrl, onDiscuss }: DocumentNavProps) {
  return (
    <div className="flex h-8 items-center justify-between border-b px-4 text-sm">
      <div className="flex items-center gap-1 min-w-0">
        <span className="truncate font-medium">{title}</span>
        {parecerUrl && <CopyLinkButton url={parecerUrl} />}
        {onDiscuss && (
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onDiscuss} title="Abrir discussão">
            <MessageSquarePlus className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon" className="h-6 w-6 disabled:opacity-50" onClick={() => onNavigate(currentIndex - 1)} disabled={currentIndex === 0}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="tabular-nums text-muted-foreground">{currentIndex + 1}/{total}</span>
        <Button variant="ghost" size="icon" className="h-6 w-6 disabled:opacity-50" onClick={() => onNavigate(currentIndex + 1)} disabled={currentIndex === total - 1}>
          <ChevronRight className="h-4 w-4" />
        </Button>
        {onToggleFullscreen && (
          <Button variant="ghost" size="icon" className="h-6 w-6 ml-1" onClick={onToggleFullscreen}>
            <Maximize2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}
