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

interface DecisionControls {
  isPending: boolean;
  onClose: () => void;
  onPrepare: (error: LlmError, decision: ErrorDecision, humanId: string) => void;
  onConfirm: (note: string) => void;
}

function decisionDescription(pending: PendingErrorDecision): string {
  const definition = pending.context?.field_definition;
  if (definition && typeof definition === "object" && "description" in definition && typeof definition.description === "string") {
    return definition.description || pending.error.fieldName;
  }
  return pending.error.fieldDescription || pending.error.fieldName;
}

function DecisionFooter({ isPending, onClose, onAction, label, disabled = false }: {
  isPending: boolean; onClose: () => void; onAction: () => void; label: string; disabled?: boolean;
}) {
  return <DialogFooter>
    <Button variant="outline" onClick={onClose} disabled={isPending}>Cancelar</Button>
    <Button onClick={onAction} disabled={isPending || disabled}>{label}</Button>
  </DialogFooter>;
}

function HumanChoice({ error, decision, isPending, onClose, onPrepare }: {
  error: LlmError; decision: ErrorDecision;
} & Pick<DecisionControls, "isPending" | "onClose" | "onPrepare">) {
  const [humanId, setHumanId] = useState("");
  const choiceId = useId();
  return <>
    <div className="space-y-2">
      <Label htmlFor={choiceId}>Qual resposta humana está sendo examinada?</Label>
      <Select value={humanId} onValueChange={setHumanId} disabled={isPending}>
        <SelectTrigger id={choiceId}><SelectValue placeholder="Selecione uma resposta" /></SelectTrigger>
        <SelectContent>{error.humanChoices?.map((choice) => (
          <SelectItem key={choice.id} value={choice.id}>{choice.label}</SelectItem>
        ))}</SelectContent>
      </Select>
    </div>
    <DecisionFooter isPending={isPending} onClose={onClose} disabled={!humanId}
      onAction={() => onPrepare(error, decision, humanId)} label="Conferir resposta" />
  </>;
}

function DecisionPreview({ decision, answer }: {
  decision: ErrorDecision; answer: ErrorResolutionContext["llm_value"];
}) {
  if (decision === "discussion") return <div className="rounded-md border p-3 text-sm">Este campo ficará sem valor final aprovado até uma nova decisão.</div>;
  const value = answer.present ? formatAnswer(answer.value) || "(vazio)" : "Resposta ausente: não é possível aprovar.";
  return <div className="rounded-md border p-3 text-sm">
    <p className="font-medium">Valor que irá para o gabarito</p>
    <p className="mt-1 whitespace-pre-wrap">{value}</p>
  </div>;
}

function ConfirmDecision({ pending, decision, context, isPending, onClose, onConfirm }: {
  pending: PendingErrorDecision; decision: ErrorDecision; context: ErrorResolutionContext;
} & Pick<DecisionControls, "isPending" | "onClose" | "onConfirm">) {
  const [note, setNote] = useState(pending.error.resolution?.note ?? "");
  const noteId = useId();
  const answer = decision === "llm_correct" ? context.llm_value : context.human_value;
  return <>
    <DecisionPreview decision={decision} answer={answer} />
    <div className="space-y-2">
      <Label htmlFor={noteId}>Nota opcional</Label>
      <Textarea id={noteId} value={note} onChange={(e) => setNote(e.target.value)} disabled={isPending} />
    </div>
    <DecisionFooter isPending={isPending} onClose={onClose} onAction={() => onConfirm(note)}
      disabled={decision !== "discussion" && !answer.present} label={isPending ? "Salvando…" : "Confirmar decisão"} />
  </>;
}

function DecisionForm({ pending, ...controls }: { pending: PendingErrorDecision } & DecisionControls) {
  const { decision, context, error } = pending;
  if (decision === null) return <>
    <p className="text-sm">Remover a decisão deste caso? O gabarito anterior volta a valer. As respostas originais não serão alteradas.</p>
    <DecisionFooter isPending={controls.isPending} onClose={controls.onClose} onAction={() => controls.onConfirm("")}
      label={controls.isPending ? "Salvando…" : "Confirmar reabertura"} />
  </>;
  if (context === null) return <HumanChoice error={error} decision={decision} {...controls} />;
  return <ConfirmDecision pending={pending} decision={decision} context={context} {...controls} />;
}

export function ErrorDecisionDialog({ pending, ...controls }: { pending: PendingErrorDecision | null } & DecisionControls) {
  if (!pending) return null;
  const title = pending.decision ? ERROR_DECISION_LABELS[pending.decision] : "Reabrir caso";
  return <Dialog open onOpenChange={(open) => { if (!open && !controls.isPending) controls.onClose(); }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{pending.error.documentTitle} · {decisionDescription(pending)}</DialogDescription>
      </DialogHeader>
      <DecisionForm key={`${pending.error.documentId}:${pending.error.fieldName}:${pending.decision}`} pending={pending} {...controls} />
    </DialogContent>
  </Dialog>;
}
