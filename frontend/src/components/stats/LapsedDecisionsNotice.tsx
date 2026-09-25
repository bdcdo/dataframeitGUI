"use client";

import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ERROR_DECISION_LABELS } from "@/lib/error-resolution";
import type { LapsedDecision } from "@/lib/llm-error-metrics";

/**
 * Decisões gravadas que saíram da fila por terem perdido a validade: a
 * pergunta mudou depois do veredito que as originou, ou as respostas em que se
 * apoiaram mudaram. Sem esta linha elas sumiriam em silêncio, e o revisor não
 * saberia que uma decisão dele deixou de valer no Gabarito.
 */
export function LapsedDecisionsNotice({ decisions }: { decisions: LapsedDecision[] }) {
  if (decisions.length === 0) return null;
  const count = decisions.length;
  return (
    <Collapsible className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground">
          {count === 1
            ? "1 decisão perdeu a validade (a pergunta mudou ou as fontes mudaram)."
            : `${count} decisões perderam a validade (a pergunta mudou ou as fontes mudaram).`}
        </p>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs">
            Listar
            <ChevronDown className="size-3" />
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <ul className="mt-2 space-y-1 text-xs">
          {decisions.map((d) => (
            <li key={`${d.documentId}:${d.fieldName}`} className="flex flex-wrap gap-x-2">
              <span className="font-medium">{d.documentTitle}</span>
              <span className="text-muted-foreground">{d.fieldDescription}</span>
              <span className="text-muted-foreground">
                {d.decision ? ERROR_DECISION_LABELS[d.decision] : "Sem decisão"}
              </span>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
