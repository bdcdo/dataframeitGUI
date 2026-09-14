"use client";

import { useId, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ERROR_DECISION_LABELS, type ErrorDecision, type ErrorResolutionContext } from "@/lib/error-resolution";
import { formatAnswer } from "@/lib/reviews/queries";
import type { LlmError } from "@/lib/llm-error-metrics";

export interface PendingErrorDecision {
  error: LlmError;
  decision: ErrorDecision | null;
  context: ErrorResolutionContext | null;
}

export function ErrorDecisionDialog({ pending, isPending, onClose, onPrepare, onConfirm }: {
  pending: PendingErrorDecision;
  isPending: boolean;
  onClose: () => void;
  onPrepare: (humanId: string) => void;
  onConfirm: (note: string) => void;
}) {
  const [humanId, setHumanId] = useState("");
  const [note, setNote] = useState(pending.error.resolution?.note ?? "");
  const noteId = useId();
  const choiceId = useId();
  const { context, decision, error } = pending;
  const definition = context?.field_definition;
  const description = definition && typeof definition === "object" && "description" in definition && typeof definition.description === "string"
    ? definition.description : error.fieldDescription;
  const needsHuman = decision !== null && context === null;
  const answer = context && (decision === "llm_correct" ? context.llm_value : context.human_value);

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !isPending) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{decision ? ERROR_DECISION_LABELS[decision] : "Reabrir caso"}</DialogTitle>
          <DialogDescription>{error.documentTitle} · {description || error.fieldName}</DialogDescription>
        </DialogHeader>
        {needsHuman ? (
          <div className="space-y-2">
            <Label htmlFor={choiceId}>Qual resposta humana está sendo examinada?</Label>
            <Select value={humanId} onValueChange={setHumanId} disabled={isPending}>
              <SelectTrigger id={choiceId}><SelectValue placeholder="Selecione uma resposta" /></SelectTrigger>
              <SelectContent>{error.humanChoices?.map((choice) => (
                <SelectItem key={choice.id} value={choice.id}>{choice.label}</SelectItem>
              ))}</SelectContent>
            </Select>
          </div>
        ) : decision === null ? (
          <p className="text-sm">Remover a decisão deste caso? O gabarito anterior volta a valer. As respostas originais não serão alteradas.</p>
        ) : (
          <>
            <div className="rounded-md border p-3 text-sm">
              {decision === "discussion" ? "Este campo ficará sem valor final aprovado até uma nova decisão." : (
                <><p className="font-medium">Valor que irá para o gabarito</p><p className="mt-1 whitespace-pre-wrap">{answer?.present ? formatAnswer(answer.value) || "(vazio)" : "Resposta ausente: não é possível aprovar."}</p></>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor={noteId}>Nota opcional</Label>
              <Textarea id={noteId} value={note} onChange={(e) => setNote(e.target.value)} disabled={isPending} />
            </div>
          </>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>Cancelar</Button>
          {needsHuman ? (
            <Button onClick={() => onPrepare(humanId)} disabled={!humanId || isPending}>Conferir resposta</Button>
          ) : (
            <Button onClick={() => onConfirm(note)} disabled={isPending || (decision !== null && decision !== "discussion" && !answer?.present)}>
              {isPending ? "Salvando…" : decision === null ? "Confirmar reabertura" : "Confirmar decisão"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
