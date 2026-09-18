"use client";

import { useId, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FieldRenderer } from "@/components/coding/FieldRenderer";
import {
  ERROR_DECISION_LABELS, effectiveErrorResolution, hasResolutionValue, prefillFromValue, prefillFromVerdict,
  type ErrorDecision, type ErrorResolutionContext,
} from "@/lib/error-resolution";
import { parsePydanticFields } from "@/lib/pydantic-field";
import { formatAnswer } from "@/lib/reviews/queries";
import { formatVerdictDisplay } from "@/lib/verdict-display";
import type { LlmError } from "@/lib/llm-error-metrics";
import type { PydanticField } from "@/lib/types";

// Reabrir não tem contexto; decidir só abre depois que o servidor devolveu o
// contexto conferido (LlmInsightsView), então os dois estados são exclusivos.
export type PendingErrorDecision =
  | { error: LlmError; decision: null; context: null }
  | { error: LlmError; decision: ErrorDecision; context: ErrorResolutionContext };

interface DecisionControls {
  isPending: boolean;
  onClose: () => void;
  /** `value` só acompanha `researchers_correct`: o que o revisor escolheu no seletor. */
  onConfirm: (note: string, value?: unknown) => void;
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

function NoteField({ note, onChange, isPending }: { note: string; onChange: (note: string) => void; isPending: boolean }) {
  const noteId = useId();
  return <div className="space-y-2">
    <Label htmlFor={noteId}>Nota opcional</Label>
    <Textarea id={noteId} value={note} onChange={(e) => onChange(e.target.value)} disabled={isPending} />
  </div>;
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

// "Erro do LLM": o veredito anterior está certo, e o revisor o expressa nas
// opções atuais da pergunta (#733). O controle é o mesmo da codificação
// (`FieldRenderer`, fonte única do mapeamento tipo → controle), pré-marcado
// quando o veredito ainda é opção do formulário; quando não é, o revisor
// escolhe a equivalente. Nada fora do formulário entra em pergunta de opções.
// De onde sai o valor inicial, na ordem: o valor já aprovado numa decisão
// "Erro do LLM" anterior desta célula (redecidir para acrescentar uma nota não
// pode descartá-lo); o texto do veredito, que é a verdade da arbitragem; e,
// quando esse texto não se traduz em opção atual (um `multi` votado em card é
// "A, C"; o snapshot humano da auto-revisão vem renderizado), a forma crua
// que a fonte guardou.
function initialValue(field: PydanticField, error: LlmError): unknown {
  const existing = effectiveErrorResolution(error.resolution);
  if (existing.status === "approved" && existing.isLlmError) return prefillFromValue(field, existing.value);
  return prefillFromVerdict(field, error.chosenVerdict)
    ?? (error.chosenValue !== undefined ? prefillFromValue(field, error.chosenValue) : undefined);
}

function PreviousVerdict({ verdict, matched }: { verdict: string; matched: boolean }) {
  return <div className="rounded-md border border-brand/40 bg-brand-muted px-3 py-2 text-sm">
    <p className="text-xs font-medium">Veredito anterior</p>
    <p className="mt-0.5 whitespace-pre-wrap">{formatVerdictDisplay(verdict) || "(vazio)"}</p>
    {!matched && (
      // Instrução, não decoração: herda a cor do corpo (o token apagado fica
      // abaixo de 4,5:1 sobre `bg-brand-muted` no tema claro).
      <p className="mt-1 text-xs">Essa resposta saiu do formulário; escolha a opção equivalente.</p>
    )}
  </div>;
}

function VerdictPicker({ pending, context, isPending, onClose, onConfirm }: {
  pending: PendingErrorDecision; context: ErrorResolutionContext;
} & Pick<DecisionControls, "isPending" | "onClose" | "onConfirm">) {
  const field = parsePydanticFields([context.field_definition])?.[0] ?? null;
  const prefill = field ? initialValue(field, pending.error) : undefined;
  const [value, setValue] = useState<unknown>(prefill);
  const [note, setNote] = useState(pending.error.resolution?.note ?? "");
  const confirmLabel = isPending ? "Salvando…" : "Confirmar decisão";
  if (!field) return <>
    <p className="text-sm text-destructive">A definição desta pergunta não pôde ser lida. Recarregue a página e tente de novo.</p>
    <DecisionFooter isPending={isPending} onClose={onClose} onAction={() => {}} disabled label={confirmLabel} />
  </>;
  return <>
    <PreviousVerdict verdict={pending.error.chosenVerdict} matched={prefill !== undefined} />
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Valor que irá para o gabarito</legend>
      <FieldRenderer field={field} value={value} onChange={setValue} />
    </fieldset>
    <NoteField note={note} onChange={setNote} isPending={isPending} />
    <DecisionFooter isPending={isPending} onClose={onClose} onAction={() => onConfirm(note, value)}
      disabled={!hasResolutionValue(field, value)} label={confirmLabel} />
  </>;
}

function ConfirmDecision({ pending, decision, context, isPending, onClose, onConfirm }: {
  pending: PendingErrorDecision; decision: Exclude<ErrorDecision, "researchers_correct">; context: ErrorResolutionContext;
} & Pick<DecisionControls, "isPending" | "onClose" | "onConfirm">) {
  const [note, setNote] = useState(pending.error.resolution?.note ?? "");
  return <>
    <DecisionPreview decision={decision} answer={context.llm_value} />
    <NoteField note={note} onChange={setNote} isPending={isPending} />
    <DecisionFooter isPending={isPending} onClose={onClose} onAction={() => onConfirm(note)}
      disabled={decision === "llm_correct" && !context.llm_value.present} label={isPending ? "Salvando…" : "Confirmar decisão"} />
  </>;
}

function DecisionForm({ pending, ...controls }: { pending: PendingErrorDecision } & DecisionControls) {
  if (pending.decision === null) return <>
    <p className="text-sm">Remover a decisão deste caso? O gabarito anterior volta a valer. As respostas originais não serão alteradas.</p>
    <DecisionFooter isPending={controls.isPending} onClose={controls.onClose} onAction={() => controls.onConfirm("")}
      label={controls.isPending ? "Salvando…" : "Confirmar reabertura"} />
  </>;
  const { decision, context } = pending;
  if (decision === "researchers_correct") return <VerdictPicker pending={pending} context={context} {...controls} />;
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
