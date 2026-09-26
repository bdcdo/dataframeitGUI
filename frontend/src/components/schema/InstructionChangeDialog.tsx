"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type {
  InstructionChangeChoice,
  InstructionChangeChoices,
} from "@/lib/question-revision";
import type { PydanticField } from "@/lib/types";
import type { InstructionChangeDialogProps } from "./useInstructionChangeGuard";

const CHOICE_LABELS: Record<InstructionChangeChoice, string> = {
  changes_answering: "Muda como responder",
  clarifies_only: "Só esclarece",
};

const CHOICE_ORDER: InstructionChangeChoice[] = ["changes_answering", "clarifies_only"];

function FieldChoice({
  field,
  choice,
  onChoose,
}: {
  field: PydanticField;
  choice: InstructionChangeChoice | undefined;
  onChoose: (choice: InstructionChangeChoice) => void;
}) {
  const labelId = `instrucao-${field.id}`;
  return (
    <li className="space-y-1.5 rounded-md border px-3 py-2">
      <p id={labelId} className="text-sm">
        <span className="font-mono">{field.name}</span>
        {field.description && (
          <span className="text-muted-foreground"> · {field.description}</span>
        )}
      </p>
      {/* Sem pré-seleção, de propósito: a escolha é obrigatória. O estado
          selecionado aparece por `aria-pressed`, pelo ícone e pela variante,
          e não só pela cor. */}
      <div role="group" aria-labelledby={labelId} className="flex gap-2">
        {CHOICE_ORDER.map((option) => {
          const selected = choice === option;
          return (
            <Button
              key={option}
              type="button"
              size="sm"
              variant={selected ? "default" : "outline"}
              aria-pressed={selected}
              onClick={() => onChoose(option)}
            >
              {selected && <Check aria-hidden="true" />}
              {CHOICE_LABELS[option]}
            </Button>
          );
        })}
      </div>
    </li>
  );
}

function missingLabel(missing: number): string {
  if (missing === 0) return "";
  return missing === 1 ? "Falta a escolha de 1 campo" : `Falta a escolha de ${missing} campos`;
}

export function InstructionChangeDialog({
  open,
  fields,
  onOpenChange,
  onConfirm,
}: InstructionChangeDialogProps & { open: boolean }) {
  const [choices, setChoices] = useState<InstructionChangeChoices>({});
  const missing = fields.filter((field) => !choices[field.id]).length;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>A nova instrução muda como responder?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-1">
              <p>Escolha para cada campo abaixo antes de salvar.</p>
              <p>
                <strong>Muda como responder:</strong> vereditos, pares &quot;=&quot;,
                auto-revisões e decisões deste campo deixam de valer.
              </p>
              <p>
                <strong>Só esclarece:</strong> nada muda.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="max-h-80 space-y-2 overflow-y-auto">
          {fields.map((field) => (
            <FieldChoice
              key={field.id}
              field={field}
              choice={choices[field.id]}
              onChoose={(choice) =>
                setChoices((current) => ({ ...current, [field.id]: choice }))
              }
            />
          ))}
        </ul>
        <AlertDialogFooter>
          {/* Sempre montada, só o texto muda: região viva que aparece junto
              com o texto não é anunciada por todo leitor de tela. */}
          <p className="mr-auto self-center text-xs text-muted-foreground" aria-live="polite">
            {missingLabel(missing)}
          </p>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction disabled={missing > 0} onClick={() => onConfirm(choices)}>
            Salvar
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
