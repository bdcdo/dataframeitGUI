"use client";

import { useEffect, useState } from "react";
import { ProgressDots } from "../coding/ProgressDots";
import { Button } from "@/components/ui/button";
import { Keyboard, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatAnswerDisplay } from "@/lib/format-answer";
import type { SelfVerdict } from "@/lib/types";

export interface AutoReviewField {
  fieldName: string;
  fieldDescription: string | null;
  humanAnswer: unknown;
  llmAnswer: unknown;
  llmJustification: string | null;
  alreadyAnswered: boolean;
}

interface AutoReviewFieldPanelProps {
  field: AutoReviewField;
  fieldIndex: number;
  totalFields: number;
  answered: boolean[];
  choice: SelfVerdict | null;
  readOnly: boolean;
  onChoose: (verdict: SelfVerdict) => void;
  onFieldNavigate: (index: number) => void;
}

export function AutoReviewFieldPanel({
  field,
  fieldIndex,
  totalFields,
  answered,
  choice,
  readOnly,
  onChoose,
  onFieldNavigate,
}: AutoReviewFieldPanelProps) {
  const [showJustification, setShowJustification] = useState(false);
  const [hintsOpen, setHintsOpen] = useState(false);

  useEffect(() => {
    setShowJustification(false);
  }, [field.fieldName]);

  useEffect(() => {
    if (readOnly) return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA"))
        return;
      if (e.key === "1") {
        e.preventDefault();
        onChoose("contesta_llm");
      } else if (e.key === "2") {
        e.preventDefault();
        onChoose("admite_erro");
      } else if (e.key.toLowerCase() === "p") {
        e.preventDefault();
        if (fieldIndex > 0) onFieldNavigate(fieldIndex - 1);
      } else if (e.key.toLowerCase() === "n") {
        e.preventDefault();
        if (fieldIndex < totalFields - 1) onFieldNavigate(fieldIndex + 1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [readOnly, onChoose, fieldIndex, totalFields, onFieldNavigate]);

  function handleChoose(v: SelfVerdict) {
    onChoose(v);
    if (fieldIndex < totalFields - 1) {
      setTimeout(() => onFieldNavigate(fieldIndex + 1), 250);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b px-4 py-1.5">
        <ProgressDots
          total={totalFields}
          currentIndex={fieldIndex}
          answered={answered}
          onNavigate={onFieldNavigate}
        />
        <div className="mt-1.5 flex items-center gap-2">
          <p className="min-w-0 truncate text-sm font-medium">
            <span className="text-muted-foreground">
              Campo {fieldIndex + 1}/{totalFields}:
            </span>{" "}
            <span className="font-mono text-xs">{field.fieldName}</span>
            {field.fieldDescription ? (
              <span className="text-muted-foreground">
                {" "}
                — {field.fieldDescription}
              </span>
            ) : null}
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-md border bg-muted/30 p-3">
            <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
              Sua resposta
            </div>
            <div className="break-words text-sm font-medium">
              {formatAnswerDisplay(field.humanAnswer)}
            </div>
          </div>
          <div className="rounded-md border bg-muted/30 p-3">
            <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
              Resposta do LLM
            </div>
            <div className="break-words text-sm font-medium">
              {formatAnswerDisplay(field.llmAnswer)}
            </div>
            {field.llmJustification ? (
              <button
                type="button"
                onClick={() => setShowJustification((v) => !v)}
                className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                {showJustification ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
                Justificativa
              </button>
            ) : null}
            {showJustification && field.llmJustification ? (
              <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                {field.llmJustification}
              </p>
            ) : null}
          </div>
        </div>

        {field.alreadyAnswered ? (
          <div className="rounded-md border border-green-500/30 bg-green-500/5 px-3 py-2 text-xs text-muted-foreground">
            Você já decidiu este campo nesta sessão. Ele será enviado quando você
            terminar todos os campos pendentes do documento.
          </div>
        ) : null}

        {readOnly ? (
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            Visualização do coordenador. Você não pode decidir auto-revisão de
            outro pesquisador.
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              variant={choice === "contesta_llm" ? "default" : "outline"}
              className={cn(
                "flex-1 min-w-[180px]",
                choice === "contesta_llm" && "ring-2 ring-brand/40",
              )}
              onClick={() => handleChoose("contesta_llm")}
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
              onClick={() => handleChoose("admite_erro")}
            >
              <kbd className="mr-2 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                2
              </kbd>
              LLM acertou (eu errei)
            </Button>
          </div>
        )}
      </div>

      <div className="border-t px-4 py-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1.5 px-2 text-xs text-muted-foreground"
          onClick={() => setHintsOpen((v) => !v)}
        >
          <Keyboard className="h-3 w-3" />
          Atalhos
        </Button>
        {hintsOpen ? (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                1
              </kbd>{" "}
              Eu acertei
            </span>
            <span>
              <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                2
              </kbd>{" "}
              LLM acertou
            </span>
            <span>
              <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                P
              </kbd>{" "}
              Campo anterior
            </span>
            <span>
              <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                N
              </kbd>{" "}
              Campo próximo
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
