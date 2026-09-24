"use client";

import { useId, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FieldRenderer } from "@/components/coding/FieldRenderer";
import {
  ERROR_DECISION_LABELS, blankAnswerFor, choosesValue, effectiveErrorResolution, hasResolutionValue, isConditionalField, llmAnswersBlank,
  prefillFromValue, prefillFromVerdict, prefillLosesItems, startsBlank,
  type ErrorDecision, type ErrorResolutionContext, type ValueChoosingDecision,
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
  /** `value` só acompanha as decisões de `choosesValue`: o que o revisor escolheu no seletor. */
  onConfirm: (note: string, value?: unknown) => void;
}

function decisionDescription(pending: PendingErrorDecision): string {
  const definition = pending.context?.field_definition;
  if (definition && typeof definition === "object" && "description" in definition && typeof definition.description === "string") {
    return definition.description || pending.error.fieldName;
  }
  return pending.error.fieldDescription || pending.error.fieldName;
}

const confirmLabel = (isPending: boolean) => (isPending ? "Salvando…" : "Confirmar decisão");

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

function DecisionPreview({ decision, answer, verdict, blankAllowed }: {
  decision: Exclude<ErrorDecision, ValueChoosingDecision>; answer: ErrorResolutionContext["llm_value"]; verdict: string; blankAllowed: boolean;
}) {
  if (decision === "discussion") return <div className="rounded-md border p-3 text-sm">Este campo ficará sem valor final aprovado até uma nova decisão.</div>;
  if (decision === "both_correct") return <div className="rounded-md border p-3 text-sm">
    <p className="font-medium">O gabarito continua sendo o veredito anterior</p>
    <p className="mt-1 whitespace-pre-wrap">{formatVerdictDisplay(verdict) || "(vazio)"}</p>
    <p className="mt-2 text-xs">A resposta do LLM deixa de contar como erro.</p>
  </div>;
  const value = answer.present ? formatAnswer(answer.value) || "(vazio)"
    : blankAllowed ? "(em branco: a pergunta não foi acionada)" : "Resposta ausente: não é possível aprovar.";
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
//
// Em "Todos errados" o veredito é justamente o que o revisor está rejeitando,
// então ele não pré-marca nada: só o valor de uma decisão "Todos errados"
// anterior da célula volta ao seletor.
function previousValue(error: LlmError, decision: ValueChoosingDecision): unknown {
  const existing = effectiveErrorResolution(error.resolution);
  return existing.status === "approved" && existing.isLlmError && error.resolution?.decision === decision
    ? existing.value : undefined;
}

function initialValue(field: PydanticField, error: LlmError, decision: ValueChoosingDecision): unknown {
  const previous = previousValue(error, decision);
  if (previous !== undefined) return prefillFromValue(field, previous);
  if (decision === "all_wrong") return undefined;
  return prefillFromVerdict(field, error.chosenVerdict)
    ?? (error.chosenValue !== undefined ? prefillFromValue(field, error.chosenValue) : undefined);
}

function PreviousVerdict({ verdict, hint }: { verdict: string; hint: string | null }) {
  return <div className="rounded-md border border-brand/40 bg-brand-muted px-3 py-2 text-sm">
    <p className="text-xs font-medium">Veredito anterior</p>
    <p className="mt-0.5 whitespace-pre-wrap">{formatVerdictDisplay(verdict) || "(vazio)"}</p>
    {hint && (
      // Instrução, não decoração: herda a cor do corpo (o token apagado fica
      // abaixo de 4,5:1 sobre `bg-brand-muted` no tema claro).
      <p className="mt-1 text-xs">{hint}</p>
    )}
  </div>;
}

// O aviso fala do veredito, então só vale quando o valor inicial veio dele:
// ao redecidir "Erro do LLM", o seletor parte do valor já aprovado, que o
// revisor escolheu. Em "Todos errados" o veredito nunca pré-marca nada.
function pickerHint(decision: ValueChoosingDecision, field: PydanticField, error: LlmError, matched: boolean): string | null {
  if (decision === "all_wrong") return "Nem esta resposta nem a do LLM vão ao gabarito; escolha abaixo a correta.";
  if (!matched) return "Essa resposta saiu do formulário; escolha a opção equivalente.";
  const existing = effectiveErrorResolution(error.resolution);
  if (existing.status === "approved" && existing.isLlmError && error.resolution?.decision === decision) return null;
  return prefillLosesItems(field, error.chosenVerdict, error.chosenValue)
    ? "Parte dessa resposta saiu do formulário; confira as opções marcadas antes de confirmar."
    : null;
}

type PickerProps = { pending: PendingErrorDecision; decision: ValueChoosingDecision } & Pick<DecisionControls, "isPending" | "onClose" | "onConfirm">;

function VerdictPicker({ context, ...props }: PickerProps & { context: ErrorResolutionContext }) {
  const field = parsePydanticFields([context.field_definition])?.[0] ?? null;
  if (field) return <FieldValuePicker field={field} llmBlank={llmAnswersBlank(context)} {...props} />;
  return <>
    <p className="text-sm text-destructive">A definição desta pergunta não pôde ser lida. Recarregue a página e tente de novo.</p>
    <DecisionFooter isPending={props.isPending} onClose={props.onClose} onAction={() => {}} disabled label={confirmLabel(props.isPending)} />
  </>;
}

// "Deixar em branco" só existe em pergunta condicional: é a resposta de quando
// o gatilho não a aciona.
// Se o LLM também deixou em branco, gravar o branco em "Erro do LLM" ou
// "Todos errados" contaria como erro do LLM uma resposta que o Gabarito marca
// como certa; o aviso aponta a decisão que registra isso.
function BlankToggle({ checked, onChange, disabled, llmBlank }: {
  checked: boolean; onChange: (blank: boolean) => void; disabled: boolean; llmBlank: boolean;
}) {
  const blankId = useId();
  return <>
    <div className="flex items-center gap-2">
      <Checkbox id={blankId} checked={checked} onCheckedChange={(state) => onChange(state === true)} disabled={disabled} />
      <Label htmlFor={blankId}>Deixar em branco (a pergunta não foi acionada)</Label>
    </div>
    {checked && llmBlank && <p className="text-sm">O LLM também deixou em branco. Se a pergunta não foi acionada, a decisão certa é &quot;Erro humano&quot;.</p>}
  </>;
}

function canConfirmValue(field: PydanticField, chosen: unknown, blankIsLlmAnswer: boolean): boolean {
  return !blankIsLlmAnswer && hasResolutionValue(field, chosen);
}

function FieldValuePicker({ field, llmBlank, pending, decision, isPending, onClose, onConfirm }: PickerProps & { field: PydanticField; llmBlank: boolean }) {
  const prefill = initialValue(field, pending.error, decision);
  const openedBlank = startsBlank(field, decision, pending.error.chosenVerdict, previousValue(pending.error, decision));
  const [value, setValue] = useState<unknown>(prefill);
  const [blank, setBlank] = useState(openedBlank);
  const [note, setNote] = useState(pending.error.resolution?.note ?? "");
  // Em branco é o vazio canônico do tipo, o único que a RPC aceita.
  const chosen = blank ? blankAnswerFor(field) : value;
  return <>
    <PreviousVerdict verdict={pending.error.chosenVerdict} hint={pickerHint(decision, field, pending.error, prefill !== undefined || openedBlank)} />
    {isConditionalField(field) && <BlankToggle checked={blank} onChange={setBlank} disabled={isPending} llmBlank={llmBlank} />}
    {!blank && <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Valor que irá para o gabarito</legend>
      <FieldRenderer field={field} value={value} onChange={setValue} />
    </fieldset>}
    <NoteField note={note} onChange={setNote} isPending={isPending} />
    <DecisionFooter isPending={isPending} onClose={onClose} onAction={() => onConfirm(note, chosen)}
      disabled={!canConfirmValue(field, chosen, blank && llmBlank)} label={confirmLabel(isPending)} />
  </>;
}

function ConfirmDecision({ pending, decision, context, isPending, onClose, onConfirm }: {
  pending: PendingErrorDecision; decision: Exclude<ErrorDecision, ValueChoosingDecision>; context: ErrorResolutionContext;
} & Pick<DecisionControls, "isPending" | "onClose" | "onConfirm">) {
  const [note, setNote] = useState(pending.error.resolution?.note ?? "");
  // Só "Erro humano" aprova o branco do LLM; "Ambos corretos" declara correta
  // uma resposta que precisa existir ao lado do veredito.
  const blankAllowed = decision === "llm_correct" && llmAnswersBlank(context);
  return <>
    <DecisionPreview decision={decision} answer={context.llm_value} verdict={pending.error.chosenVerdict} blankAllowed={blankAllowed} />
    <NoteField note={note} onChange={setNote} isPending={isPending} />
    <DecisionFooter isPending={isPending} onClose={onClose} onAction={() => onConfirm(note)}
      disabled={decision !== "discussion" && !context.llm_value.present && !blankAllowed} label={confirmLabel(isPending)} />
  </>;
}

function DecisionForm({ pending, ...controls }: { pending: PendingErrorDecision } & DecisionControls) {
  if (pending.decision === null) return <>
    <p className="text-sm">Remover a decisão deste caso? O gabarito anterior volta a valer. As respostas originais não serão alteradas.</p>
    <DecisionFooter isPending={controls.isPending} onClose={controls.onClose} onAction={() => controls.onConfirm("")}
      label={controls.isPending ? "Salvando…" : "Confirmar reabertura"} />
  </>;
  const { decision, context } = pending;
  if (choosesValue(decision)) return <VerdictPicker pending={pending} decision={decision} context={context} {...controls} />;
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
