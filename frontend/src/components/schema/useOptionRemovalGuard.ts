"use client";

import { useState } from "react";
import {
  findConditionConflicts,
  type ConditionConflict,
} from "@/lib/schema-utils";
import type { PydanticField } from "@/lib/types";

interface PendingRemoval {
  option: string;
  conflicts: ConditionConflict[];
  resolve: (confirmed: boolean) => void;
}

export interface RemovalGuardDialogProps {
  option: string;
  conflicts: ConditionConflict[];
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

/**
 * Guarda de remoção de opção usada em `condition` de outros campos: detecta
 * conflitos e, se houver, suspende a remoção numa Promise até o usuário
 * decidir no RemoveOptionDialog. Compartilhada entre FieldCard e
 * EditFieldDialog; o pai renderiza
 * `{dialogProps && <RemoveOptionDialog open {...dialogProps} />}`.
 *
 * `confirmRemoval` devolve também os `conflicts` porque o FieldCard precisa
 * distinguir "sem conflitos" (deixa o OptionsEditor remover) de "conflitos
 * confirmados" (ele mesmo aplica strip + remoção via onAllFieldsChange).
 */
export function useOptionRemovalGuard(
  allFields: PydanticField[],
  fieldName: string,
): {
  confirmRemoval: (
    opt: string,
  ) => Promise<{ confirmed: boolean; conflicts: ConditionConflict[] }>;
  dialogProps: RemovalGuardDialogProps | null;
} {
  const [pendingRemoval, setPendingRemoval] = useState<PendingRemoval | null>(
    null,
  );

  const confirmRemoval = async (opt: string) => {
    const conflicts = findConditionConflicts(allFields, fieldName, opt);
    if (conflicts.length === 0) return { confirmed: true, conflicts };
    const confirmed = await new Promise<boolean>((resolve) => {
      setPendingRemoval({ option: opt, conflicts, resolve });
    });
    return { confirmed, conflicts };
  };

  const dialogProps: RemovalGuardDialogProps | null = pendingRemoval
    ? {
        option: pendingRemoval.option,
        conflicts: pendingRemoval.conflicts,
        onOpenChange: (open) => {
          if (!open) {
            pendingRemoval.resolve(false);
            setPendingRemoval(null);
          }
        },
        onConfirm: () => {
          pendingRemoval.resolve(true);
          setPendingRemoval(null);
        },
      }
    : null;

  return { confirmRemoval, dialogProps };
}
