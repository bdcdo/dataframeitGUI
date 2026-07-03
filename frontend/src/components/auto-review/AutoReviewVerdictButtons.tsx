"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SelfVerdict } from "@/lib/types";

// Botões de verdict do AutoReviewFieldPanel (branch !readOnly); o aviso de
// coordenador (readOnly) e a variante já-respondida ficam no painel.
export function AutoReviewVerdictButtons({
  choice,
  onChoose,
}: {
  choice: SelfVerdict | null;
  onChoose: (verdict: SelfVerdict) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant={choice === "contesta_llm" ? "default" : "outline"}
        className={cn(
          "flex-1 min-w-[180px]",
          choice === "contesta_llm" && "ring-2 ring-brand/40",
        )}
        onClick={() => onChoose("contesta_llm")}
      >
        <kbd className="mr-2 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
          1
        </kbd>
        Eu acertei (LLM errou)
      </Button>
      <Button
        variant={choice === "admite_erro" ? "default" : "outline"}
        className={cn(
          "flex-1 min-w-[180px]",
          choice === "admite_erro" && "ring-2 ring-brand/40",
        )}
        onClick={() => onChoose("admite_erro")}
      >
        <kbd className="mr-2 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
          2
        </kbd>
        LLM acertou (eu errei)
      </Button>
      <Button
        variant={choice === "equivalente" ? "default" : "outline"}
        className={cn(
          "flex-1 min-w-[180px]",
          choice === "equivalente" && "ring-2 ring-brand/40",
        )}
        onClick={() => onChoose("equivalente")}
        title="As duas respostas dizem a mesma coisa de formas diferentes"
      >
        <kbd className="mr-2 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
          3
        </kbd>
        Respostas equivalentes
      </Button>
      <Button
        variant={choice === "ambiguo" ? "default" : "outline"}
        className={cn(
          "flex-1 min-w-[180px]",
          choice === "ambiguo" && "ring-2 ring-brand/40",
        )}
        onClick={() => onChoose("ambiguo")}
        title="Campo ambíguo — gera um comentário para discussão"
      >
        <kbd className="mr-2 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
          4
        </kbd>
        Ambíguo (discutir)
      </Button>
    </div>
  );
}
