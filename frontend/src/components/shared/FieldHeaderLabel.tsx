import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface FieldHeaderLabelProps {
  prefix: ReactNode;
  children: ReactNode;
  helpText?: string | null;
  className?: string;
  labelClassName?: string;
  helpTextClassName?: string;
}

// Prefixo + descrição de um campo (ex.: "Campo 1/5: Data do parecer"), com o
// help_text opcional logo abaixo. Compartilhado entre Codificação
// (QuestionsPanel), Comparação (ComparisonPanel) e Revisão Automática
// (AutoReviewFieldPanel) — as três telas mostravam essa dupla de formas
// levemente divergentes e apenas uma exibia help_text (#373/#365).
export function FieldHeaderLabel({
  prefix,
  children,
  helpText,
  className,
  labelClassName,
  helpTextClassName,
}: FieldHeaderLabelProps) {
  return (
    <div className={cn("min-w-0", className)}>
      <p className={cn("flex items-center gap-1.5 text-sm font-medium", labelClassName)}>
        <span className="text-muted-foreground">{prefix}</span>
        {children}
      </p>
      {helpText && (
        <p
          className={cn(
            "mt-1 whitespace-pre-line text-xs text-muted-foreground",
            helpTextClassName,
          )}
        >
          {helpText}
        </p>
      )}
    </div>
  );
}
