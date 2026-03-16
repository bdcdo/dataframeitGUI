"use client";

import { useTransition } from "react";
import { clearPendingAssignments } from "@/actions/assignments";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Trash2 } from "lucide-react";

interface ClearPendingButtonProps {
  projectId: string;
  pendingCount: number;
}

export function ClearPendingButton({ projectId, pendingCount }: ClearPendingButtonProps) {
  const [isPending, startTransition] = useTransition();

  const handleClear = () => {
    startTransition(async () => {
      await clearPendingAssignments(projectId);
    });
  };

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={isPending}>
          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
          Limpar pendentes ({pendingCount})
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Limpar atribuições pendentes?</AlertDialogTitle>
          <AlertDialogDescription>
            Isso removerá <strong>{pendingCount}</strong> atribuição(ões) pendente(s).
            Atribuições em andamento e concluídas serão preservadas.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction onClick={handleClear} disabled={isPending}>
            {isPending ? "Removendo…" : "Confirmar"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
