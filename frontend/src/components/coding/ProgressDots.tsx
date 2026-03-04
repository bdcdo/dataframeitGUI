"use client";

import { cn } from "@/lib/utils";

interface ProgressDotsProps {
  total: number;
  currentIndex: number;
  answered: boolean[];
  onNavigate: (index: number) => void;
}

export function ProgressDots({ total, currentIndex, answered, onNavigate }: ProgressDotsProps) {
  return (
    <div className="flex flex-wrap gap-1.5 px-2 py-1">
      {Array.from({ length: total }).map((_, i) => (
        <button
          key={i}
          onClick={() => onNavigate(i)}
          className={cn(
            "rounded-full transition-all",
            i === currentIndex ? "h-3 w-3" : "h-2 w-2",
            answered[i] ? "bg-brand" : "bg-muted-foreground/30",
            i === currentIndex && "ring-2 ring-brand/30"
          )}
          title={`Pergunta ${i + 1}`}
        />
      ))}
    </div>
  );
}
