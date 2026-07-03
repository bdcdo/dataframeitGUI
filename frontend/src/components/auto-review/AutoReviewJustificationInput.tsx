"use client";

import { useEffect, useRef } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { verdictRequiresJustification } from "@/lib/auto-review-decided";
import type { SelfVerdict } from "@/lib/types";

// Input de justificativa do AutoReviewFieldPanel. O condicional de render
// (!readOnly && !alreadyAnswered && exige justificativa) fica no painel; a
// variante read-only (selfJustification já salva) também.
export function AutoReviewJustificationInput({
  choice,
  justification,
  onChange,
}: {
  choice: SelfVerdict | null;
  justification: string;
  onChange: (value: string) => void;
}) {
  const justificationMissing = !justification.trim();

  // Foca o textarea ao escolher um verdict que exige justificativa — sem isto,
  // teclar o atalho abre o campo mas deixa o foco para tras. Keyed so em
  // `choice`: navegar entre dois campos com o mesmo verdict nao rerroda o effect
  // (mesmo valor), entao o foco so vai para o textarea no ato de escolher.
  const justificationRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (verdictRequiresJustification(choice)) justificationRef.current?.focus();
  }, [choice]);

  return (
    <div className="space-y-1.5">
      <Label htmlFor="self-justification" className="text-sm">
        Justificativa <span className="text-destructive">*</span>
      </Label>
      <Textarea
        id="self-justification"
        ref={justificationRef}
        rows={3}
        value={justification}
        onChange={(e) => onChange(e.target.value)}
        placeholder={
          choice === "ambiguo"
            ? "Por que este campo é ambíguo? Isto será incluído no comentário de discussão."
            : "Por que você acha que sua resposta está correta? O árbitro verá isto."
        }
        className={cn(
          justificationMissing &&
            "border-destructive focus-visible:border-destructive focus-visible:ring-destructive/20",
        )}
      />
      {justificationMissing ? (
        <p className="text-xs text-destructive">
          Obrigatória: sem ela este campo não é enviado.
        </p>
      ) : null}
    </div>
  );
}
