"use client";

import { useState, useTransition } from "react";
import { clearPendingAssignments } from "@/actions/assignments";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { Trash2 } from "lucide-react";

interface ClearPendingButtonProps {
  projectId: string;
  pendingByType: {
    codificacao: number;
    comparacao: number;
  };
}

type TargetType = "codificacao" | "comparacao";

export function ClearPendingButton({ projectId, pendingByType }: ClearPendingButtonProps) {
  const [isPending, startTransition] = useTransition();
  const [target, setTarget] = useState<TargetType | null>(null);

  const totalPending = pendingByType.codificacao + pendingByType.comparacao;

  const handleConfirm = () => {
    if (!target) return;
    const type = target;
    setTarget(null);
    startTransition(async () => {
      await clearPendingAssignments(projectId, type);
    });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={isPending}>
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            Limpar pendentes ({totalPending})
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {pendingByType.codificacao > 0 && (
            <DropdownMenuItem onSelect={() => setTarget("codificacao")}>
              Codificação ({pendingByType.codificacao})
            </DropdownMenuItem>
          )}
          {pendingByType.comparacao > 0 && (
            <DropdownMenuItem onSelect={() => setTarget("comparacao")}>
              Comparação ({pendingByType.comparacao})
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={target !== null} onOpenChange={(v) => !v && setTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Limpar atribuições pendentes?</AlertDialogTitle>
            <AlertDialogDescription>
              Isso removerá <strong>{target ? pendingByType[target] : 0}</strong> atribuição(ões)
              pendente(s) de <strong>{target === "comparacao" ? "comparação" : "codificação"}</strong>.
              Atribuições em andamento e concluídas serão preservadas.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirm} disabled={isPending}>
              {isPending ? "Removendo…" : "Confirmar"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
