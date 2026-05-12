"use client";

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
import type { ConditionConflict } from "@/lib/schema-utils";

interface RemoveOptionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  option: string;
  conflicts: ConditionConflict[];
  onConfirm: () => void;
}

export function RemoveOptionDialog({
  open,
  onOpenChange,
  option,
  conflicts,
  onConfirm,
}: RemoveOptionDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remover opção em uso?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                A opção <strong>&quot;{option}&quot;</strong> é usada na
                condição de{" "}
                {conflicts.length === 1
                  ? "1 campo"
                  : `${conflicts.length} campos`}
                :
              </p>
              <ul className="list-disc space-y-0.5 pl-5 text-sm">
                {conflicts.map((c) => (
                  <li key={c.fieldName}>
                    <span className="font-mono">{c.fieldName}</span>{" "}
                    <span className="text-muted-foreground">
                      ({c.fieldLabel}, {c.conditionKey})
                    </span>
                  </li>
                ))}
              </ul>
              <p>
                Se você remover, as condições afetadas também serão atualizadas
                (o valor sai da lista <code>in/not_in</code> ou a condition
                inteira é removida se for <code>equals/not_equals</code>).
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            Remover e atualizar condições
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
