"use client";

import { useState } from "react";
import { CustomAnswerInput } from "./CustomAnswerInput";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Lightbulb } from "lucide-react";
import { AddNoteButton } from "@/components/shared/AddNoteButton";
import { SuggestFieldDialog } from "@/components/stats/SuggestFieldDialog";
import { formatVerdictDisplay } from "@/lib/verdict-display";
import type { VerdictInfo } from "@/lib/compare-reviews";
import type { PydanticField } from "@/lib/types";

interface DivergenceActionsPanelProps {
  projectId: string;
  documentId: string;
  documentTitle: string;
  fieldName: string;
  fieldDescription: string;
  fields: PydanticField[];
  isMulti: boolean;
  existingVerdict: VerdictInfo | null;
  // Só o veredito: voto com chosenResponseId é papel do AgreementGroup, não
  // deste painel — o pai passa seu handler mais largo por contravariância.
  onVerdict: (verdict: string) => void;
  comment: string;
  onCommentChange: (value: string) => void;
}

// Ações do campo divergente: marcadores Ambíguo/Pular + resposta nova, veredito
// anterior e a linha de feedback (comentário, nota, sugestão de schema). O
// dialog de sugestão mora aqui junto do seu único gatilho (o botão Sugerir).
export function DivergenceActionsPanel({
  projectId,
  documentId,
  documentTitle,
  fieldName,
  fieldDescription,
  fields,
  isMulti,
  existingVerdict,
  onVerdict,
  comment,
  onCommentChange,
}: DivergenceActionsPanelProps) {
  const [suggestOpen, setSuggestOpen] = useState(false);

  return (
    <>
      {!isMulti && (
        <div className="mt-2 flex flex-wrap gap-1">
          <Button
            variant="outline"
            size="sm"
            className={cn(
              existingVerdict?.verdict === "ambiguo" &&
                "border-brand bg-brand/10 text-brand",
            )}
            onClick={() => onVerdict("ambiguo")}
          >
            [A] Ambiguo
          </Button>
          <Button
            variant="outline"
            size="sm"
            className={cn(
              existingVerdict?.verdict === "pular" &&
                "border-brand bg-brand/10 text-brand",
            )}
            onClick={() => onVerdict("pular")}
          >
            [S] Pular
          </Button>
          {/*
            "Nenhuma correta" + input de resposta nova (issue #247, ponto
            4). Keyed por doc|campo: navegar remonta e reseta o estado
            interno (aberto/valor) sem reset-em-effect — react-doctor só
            aceita key={identidade} para reset-on-prop-change.

            currentValue: no bloco !isMulti, um veredito de texto sem
            chosenResponseId que não seja marcador especial é, por
            construção, uma resposta custom (voto sempre carrega
            chosenResponseId). Passá-lo destaca o botão e re-semeia o
            input ao revisitar o campo — paridade com Ambíguo/Pular.
          */}
          <CustomAnswerInput
            key={`${documentId}|${fieldName}`}
            currentValue={
              existingVerdict &&
              existingVerdict.verdict !== "ambiguo" &&
              existingVerdict.verdict !== "pular" &&
              !existingVerdict.chosenResponseId
                ? existingVerdict.verdict
                : null
            }
            onSubmit={(value) => onVerdict(value)}
          />
        </div>
      )}

      {existingVerdict && (
        <div className="mt-2 rounded-md bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
          Veredito anterior:{" "}
          <span className="font-medium text-foreground">
            {formatVerdictDisplay(existingVerdict.verdict)}
          </span>
          {existingVerdict.comment && (
            <span className="ml-1">
              &mdash; &ldquo;{existingVerdict.comment}&rdquo;
            </span>
          )}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Input
          placeholder="Comentário (opcional)"
          value={comment}
          onChange={(e) => onCommentChange(e.target.value)}
          className="flex-1 min-w-[180px] text-sm"
        />
        <AddNoteButton
          key={documentId}
          projectId={projectId}
          documentId={documentId}
          documentTitle={documentTitle}
          fieldName={fieldName}
          fieldLabel={fieldDescription}
          variant="outline"
          size="sm"
          label="Anotar"
        />
        <Button
          variant="outline"
          size="sm"
          className="gap-1"
          onClick={() => setSuggestOpen(true)}
          title="Sugerir alteração ao codebook neste campo"
        >
          <Lightbulb className="size-3.5" />
          Sugerir
        </Button>
      </div>

      <SuggestFieldDialog
        // Remonta ao trocar de campo: o form do dialog renasce semeado pelos
        // valores do novo campo, dispensando o reset-em-render por prop.
        key={fieldName}
        projectId={projectId}
        fieldName={fieldName}
        allFields={fields}
        open={suggestOpen}
        onOpenChange={setSuggestOpen}
      />
    </>
  );
}
