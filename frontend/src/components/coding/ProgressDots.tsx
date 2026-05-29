"use client";

import { cn } from "@/lib/utils";

interface ProgressDotsProps {
  total: number;
  currentIndex: number;
  answered: boolean[];
  concordant?: boolean[];
  /** campo iniciado mas ainda incompleto (ex: contesta_llm sem justificativa) */
  incomplete?: boolean[];
  onNavigate: (index: number) => void;
}

export function ProgressDots({ total, currentIndex, answered, concordant, incomplete, onNavigate }: ProgressDotsProps) {
  return (
    <div className="flex flex-wrap justify-center gap-1.5 px-2 py-1">
      {Array.from({ length: total }).map((_, i) => {
        const isConcordant = concordant?.[i] ?? false;
        const isIncomplete = incomplete?.[i] ?? false;
        return (
          <button
            type="button"
            key={i}
            aria-label={`Ir para pergunta ${i + 1}`}
            onClick={() => onNavigate(i)}
            className={cn(
              "rounded-full transition-all",
              i === currentIndex ? "size-3" : "size-2",
              isConcordant
                ? "bg-muted-foreground/30"
                : answered[i]
                  ? "bg-brand"
                  : isIncomplete
                    ? "border border-amber-500 bg-amber-500/30"
                    : "border border-muted-foreground/40 bg-transparent",
              i === currentIndex && "ring-2 ring-brand/30"
            )}
            title={`Pergunta ${i + 1}${
              isConcordant
                ? " (concordante)"
                : isIncomplete
                  ? " (falta justificativa)"
                  : ""
            }`}
          />
        );
      })}
    </div>
  );
}
