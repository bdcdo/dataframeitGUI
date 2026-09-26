"use client";

import { useState } from "react";
import {
  fieldsWithInstructionOnlyChange,
  type InstructionChangeChoices,
} from "@/lib/question-revision";
import type { PydanticField } from "@/lib/types";

interface PendingInstructionChange {
  fields: PydanticField[];
  resolve: (choices: InstructionChangeChoices | null) => void;
}

export interface InstructionChangeDialogProps {
  fields: PydanticField[];
  onOpenChange: (open: boolean) => void;
  onConfirm: (choices: InstructionChangeChoices) => void;
}

/**
 * Pergunta, antes de gravar, se cada instrução alterada muda como responder.
 * Compartilhada pelas duas entradas de save de schema (SchemaEditor e
 * EditFieldDialog); o pai renderiza
 * `{dialogProps && <InstructionChangeDialog open {...dialogProps} />}`.
 *
 * `confirmInstructionChanges` devolve as escolhas, ou `null` quando quem edita
 * desiste; sem instrução alterada, devolve `{}` sem abrir nada. Quem chama
 * aplica as escolhas com `applyInstructionChoices` sobre o estado do momento
 * do save, e não sobre o de quando o diálogo abriu, que pode ter sido rebasado
 * enquanto ele estava aberto.
 *
 * Tem de ser chamada FORA de `startTransition`: as atualizações de estado de
 * uma ação assíncrona só são aplicadas quando ela termina, e o diálogo, aberto
 * de dentro dela, esperaria uma resposta que nunca chegaria a aparecer na tela.
 */
export function useInstructionChangeGuard(): {
  confirmInstructionChanges: (
    savedFields: readonly PydanticField[],
    draftFields: readonly PydanticField[],
  ) => Promise<InstructionChangeChoices | null>;
  dialogProps: InstructionChangeDialogProps | null;
} {
  const [pending, setPending] = useState<PendingInstructionChange | null>(null);

  const confirmInstructionChanges = async (
    savedFields: readonly PydanticField[],
    draftFields: readonly PydanticField[],
  ): Promise<InstructionChangeChoices | null> => {
    const fields = fieldsWithInstructionOnlyChange(savedFields, draftFields);
    if (fields.length === 0) return {};
    return new Promise<InstructionChangeChoices | null>((resolve) => {
      setPending({ fields, resolve });
    });
  };

  const dialogProps: InstructionChangeDialogProps | null = pending
    ? {
        fields: pending.fields,
        onOpenChange: (open) => {
          if (!open) {
            pending.resolve(null);
            setPending(null);
          }
        },
        onConfirm: (choices) => {
          pending.resolve(choices);
          setPending(null);
        },
      }
    : null;

  return { confirmInstructionChanges, dialogProps };
}
