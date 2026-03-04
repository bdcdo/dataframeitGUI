"use client";

import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface DocumentNavProps {
  title: string;
  currentIndex: number;
  total: number;
  onNavigate: (index: number) => void;
}

export function DocumentNav({ title, currentIndex, total, onNavigate }: DocumentNavProps) {
  return (
    <div className="flex h-8 items-center justify-between border-b px-4 text-sm">
      <span className="truncate font-medium">{title}</span>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => onNavigate(currentIndex - 1)} disabled={currentIndex === 0}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="text-muted-foreground">{currentIndex + 1}/{total}</span>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => onNavigate(currentIndex + 1)} disabled={currentIndex === total - 1}>
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
