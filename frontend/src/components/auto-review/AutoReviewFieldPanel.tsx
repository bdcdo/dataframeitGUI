"use client";

import { useState } from "react";
import { ProgressDots } from "../coding/ProgressDots";
import { ChevronDown, ChevronRight } from "lucide-react";
import { verdictRequiresJustification } from "@/lib/auto-review-decided";
import { formatAnswerDisplay } from "@/lib/format-answer";
import { FieldHeaderLabel } from "@/components/shared/FieldHeaderLabel";
import type { SelfVerdict } from "@/lib/types";
import { useAutoReviewKeyboard } from "./useAutoReviewKeyboard";
import { AutoReviewVerdictButtons } from "./AutoReviewVerdictButtons";
import { AutoReviewJustificationInput } from "./AutoReviewJustificationInput";
import { AutoReviewFooter } from "./AutoReviewFooter";

export interface AutoReviewField {
  fieldName: string;
  fieldDescription: string | null;
  fieldHelpText: string | null;
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
  /** campos contesta_llm sem justificativa — destacados como incompletos */
  incomplete: boolean[];
  choice: SelfVerdict | null;
  justification: string;
  readOnly: boolean;
  /** quantos campos estão prontos para o próximo envio parcial */
  readyCount: number;
  /** quantos campos foram iniciados mas estão sem justificativa */
  incompleteCount: number;
  submitting: boolean;
  canSubmit: boolean;
  onSubmit: () => void;
  onChoose: (verdict: SelfVerdict) => void;
  onJustificationChange: (value: string) => void;
  onFieldNavigate: (index: number) => void;
}

export function AutoReviewFieldPanel({
  field,
  fieldIndex,
  totalFields,
  answered,
  incomplete,
  choice,
  justification,
  readOnly,
  readyCount,
  incompleteCount,
  submitting,
  canSubmit,
  onSubmit,
  onChoose,
  onJustificationChange,
  onFieldNavigate,
}: AutoReviewFieldPanelProps) {
  // Aberta por padrão: pesquisador precisa ler a justificativa para decidir
  // entre "eu acertei" / "LLM acertou", então esconder por default era um
  // clique extra desnecessário.
  const [showJustification, setShowJustification] = useState(true);

  // Nao ha effect para reabrir a justificativa ao trocar de campo: o pai
  // remonta o painel via `key={currentKey}`, entao `showJustification` ja
  // nasce no default aberto a cada (doc, campo).

  const { handleChoose } = useAutoReviewKeyboard({
    readOnly,
    fieldIndex,
    totalFields,
    answered,
    onChoose,
    onFieldNavigate,
  });

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b px-4 py-1.5">
        <ProgressDots
          total={totalFields}
          currentIndex={fieldIndex}
          answered={answered}
          incomplete={incomplete}
          onNavigate={onFieldNavigate}
        />
        <div className="mt-1.5 flex items-start gap-2">
          <FieldHeaderLabel
            prefix={`Campo ${fieldIndex + 1}/${totalFields}:`}
            helpText={field.fieldHelpText}
            helpTextClassName="max-h-24 overflow-y-auto pr-1"
          >
            <span className="font-mono text-xs">{field.fieldName}</span>
            {field.fieldDescription ? (
              <span className="text-muted-foreground">
                {": "}
                {field.fieldDescription}
              </span>
            ) : null}
          </FieldHeaderLabel>
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
                  <ChevronDown className="size-3" />
                ) : (
                  <ChevronRight className="size-3" />
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
            Decisão já enviada para este campo.
          </div>
        ) : null}

        {readOnly ? (
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            Visualização do coordenador. Você não pode decidir auto-revisão de
            outro pesquisador.
          </div>
        ) : (
          <AutoReviewVerdictButtons choice={choice} onChoose={handleChoose} />
        )}

        {!readOnly &&
        !field.alreadyAnswered &&
        verdictRequiresJustification(choice) ? (
          <AutoReviewJustificationInput
            choice={choice}
            justification={justification}
            onChange={onJustificationChange}
          />
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

      <AutoReviewFooter
        readOnly={readOnly}
        readyCount={readyCount}
        incompleteCount={incompleteCount}
        submitting={submitting}
        canSubmit={canSubmit}
        onSubmit={onSubmit}
      />
    </div>
  );
}
