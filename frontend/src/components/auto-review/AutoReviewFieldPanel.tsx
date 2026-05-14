"use client";

import { useEffect, useRef, useState } from "react";
import { ProgressDots } from "../coding/ProgressDots";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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
  selfJustification: string | null;
}

interface AutoReviewFieldPanelProps {
  field: AutoReviewField;
  fieldIndex: number;
  totalFields: number;
  answered: boolean[];
  choice: SelfVerdict | null;
  justification: string;
  readOnly: boolean;
  onChoose: (verdict: SelfVerdict) => void;
  onJustificationChange: (value: string) => void;
  onFieldNavigate: (index: number) => void;
}

const HINTS_DISMISSED_KEY = "autoReview:hintsDismissed";

export function AutoReviewFieldPanel({
  field,
  fieldIndex,
  totalFields,
  answered,
  choice,
  justification,
  readOnly,
  onChoose,
  onJustificationChange,
  onFieldNavigate,
}: AutoReviewFieldPanelProps) {
  // Aberta por padrão: pesquisador precisa ler a justificativa para decidir
  // entre "eu acertei" / "LLM acertou", então esconder por default era um
  // clique extra desnecessário.
  const [showJustification, setShowJustification] = useState(true);
  // Hints começam abertos até o usuário fechar uma vez (persistido em localStorage).
  // Lazy initializer roda só uma vez no mount, lê do localStorage sem flicker.
  const [hintsOpen, setHintsOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(HINTS_DISMISSED_KEY) === null;
  });

  // Listener de teclado registra uma vez (por readOnly); callbacks frescos
  // chegam via ref para evitar reregistro a cada keystroke.
  const handlerRef = useRef({ onChoose, onFieldNavigate, fieldIndex, totalFields });
  useEffect(() => {
    handlerRef.current = { onChoose, onFieldNavigate, fieldIndex, totalFields };
  });

  function toggleHints() {
    setHintsOpen((v) => {
      const next = !v;
      if (typeof window !== "undefined" && !next) {
        window.localStorage.setItem(HINTS_DISMISSED_KEY, "1");
      }
      return next;
    });
  }

  useEffect(() => {
    setShowJustification(true);
  }, [field.fieldName]);

  // Auto-advance pós-decisão: armazena handle do timeout num ref para poder
  // cancelar se o usuário trocar de doc/campo antes do disparo (evita pular
  // índice em contexto desatualizado).
  const advanceTimeoutRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (advanceTimeoutRef.current !== null) {
        window.clearTimeout(advanceTimeoutRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (readOnly) return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA"))
        return;
      const { onChoose, onFieldNavigate, fieldIndex, totalFields } =
        handlerRef.current;
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
  }, [readOnly]);

  function handleChoose(v: SelfVerdict) {
    onChoose(v);
    // contesta_llm exige justificativa: não auto-avança, senão o pesquisador
    // perderia o campo de texto que acabou de abrir.
    if (v === "contesta_llm") return;
    // Pula campos já respondidos no auto-advance pós-clique (P/N manuais
    // continuam navegando livremente para permitir re-conferência).
    const nextUnanswered = answered.findIndex((a, i) => i > fieldIndex && !a);
    if (nextUnanswered === -1) return;
    if (advanceTimeoutRef.current !== null) {
      window.clearTimeout(advanceTimeoutRef.current);
    }
    advanceTimeoutRef.current = window.setTimeout(() => {
      advanceTimeoutRef.current = null;
      onFieldNavigate(nextUnanswered);
    }, 250);
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

        {!readOnly && !field.alreadyAnswered && choice === "contesta_llm" ? (
          <div className="space-y-1.5">
            <Label htmlFor="self-justification" className="text-sm">
              Justificativa <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="self-justification"
              rows={3}
              value={justification}
              onChange={(e) => onJustificationChange(e.target.value)}
              placeholder="Por que você acha que sua resposta está correta? O árbitro verá isto."
            />
          </div>
        ) : null}

        {(readOnly || field.alreadyAnswered) && field.selfJustification ? (
          <div className="space-y-1">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Sua justificativa
            </div>
            <p className="whitespace-pre-wrap border-l-2 border-muted pl-2 text-xs text-muted-foreground">
              {field.selfJustification}
            </p>
          </div>
        ) : null}
      </div>

      <div className="border-t px-4 py-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1.5 px-2 text-xs text-muted-foreground"
          onClick={toggleHints}
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
