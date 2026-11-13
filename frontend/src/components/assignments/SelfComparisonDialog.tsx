"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { cycleAssignment } from "@/actions/assignments";
import { ConfirmActionDialog } from "@/components/ui/confirm-action-dialog";

export interface SelfComparisonRequest {
  docId: string;
  userId: string;
  docLabel: string;
  researcherName: string;
}

/**
 * Confirmação da autocomparação: o passo do ciclo daria a comparação a quem
 * codificou o documento, e `cycleAssignment` só grava com `allowSelfComparison`
 * — a liberação fica registrada no banco com o nome de quem confirmou.
 */
export function SelfComparisonDialog({
  projectId,
  request,
  onClose,
}: {
  projectId: string;
  request: SelfComparisonRequest | null;
  onClose: () => void;
}) {
  const [isPending, startTransition] = useTransition();

  const confirm = () => {
    if (!request) return;
    startTransition(async () => {
      const result = await cycleAssignment(projectId, request.docId, request.userId, {
        allowSelfComparison: true,
      });
      if (result.error) {
        toast.error(result.error);
        return;
      }
      onClose();
      toast.success("Autocomparação liberada.");
    });
  };

  return (
    <ConfirmActionDialog
      open={request !== null}
      onClose={onClose}
      title="Liberar autocomparação?"
      description={
        request
          ? `${request.researcherName} codificou o documento ${request.docLabel}. Por padrão, quem codificou não compara o próprio documento. Liberando, essa pessoa compara a própria codificação com as demais respostas (por exemplo, a do LLM). A liberação fica registrada com seu nome, e o export marca o documento como autocomparação.`
          : ""
      }
      confirmLabel="Liberar autocomparação"
      isPending={isPending}
      pendingLabel="Liberando..."
      onConfirm={confirm}
    />
  );
}
