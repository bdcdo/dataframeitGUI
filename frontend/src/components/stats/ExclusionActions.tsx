"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  approveExclusionRequest,
  rejectExclusionRequest,
} from "@/actions/project-comments";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

export function ExclusionActions({
  commentId,
  projectId,
  status,
  rejectedReason,
  isCoordinator,
}: {
  commentId: string;
  projectId: string;
  status: "pending" | "approved" | "rejected";
  rejectedReason?: string | null;
  isCoordinator: boolean;
}) {
  const { refresh } = useRouter();
  const [isPending, startAction] = useTransition();
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const rejectTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (showRejectInput) {
      rejectTextareaRef.current?.focus();
    }
  }, [showRejectInput]);

  if (status === "approved") {
    return (
      <Badge className="text-xs bg-red-500/10 text-red-700 w-fit">
        Documento excluído
      </Badge>
    );
  }
  if (status === "rejected") {
    return (
      <div className="flex flex-col gap-1">
        <Badge className="text-xs bg-muted text-muted-foreground w-fit">
          Sugestão rejeitada
        </Badge>
        {rejectedReason && (
          <p className="text-xs text-muted-foreground italic">
            Motivo: {rejectedReason}
          </p>
        )}
      </div>
    );
  }

  if (!isCoordinator) {
    return (
      <Badge className="text-xs bg-amber-500/10 text-amber-700 w-fit">
        Aguardando coordenador
      </Badge>
    );
  }

  if (showRejectInput) {
    return (
      <div className="flex flex-col gap-2">
        <Textarea
          ref={rejectTextareaRef}
          className="text-xs"
          placeholder="Motivo da rejeição"
          value={rejectReason}
          onChange={(e) => setRejectReason(e.target.value)}
          rows={2}
        />
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-xs"
            disabled={isPending}
            onClick={() => {
              setShowRejectInput(false);
              setRejectReason("");
            }}
          >
            Cancelar
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="h-6 text-xs"
            disabled={isPending || !rejectReason.trim()}
            onClick={() => {
              startAction(async () => {
                const result = await rejectExclusionRequest(
                  commentId,
                  projectId,
                  rejectReason,
                );
                if (result.error) toast.error(result.error);
                else {
                  toast.success("Sugestão rejeitada");
                  refresh();
                }
              });
            }}
          >
            Confirmar rejeição
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="destructive"
        size="sm"
        className="h-6 text-xs"
        disabled={isPending}
        onClick={() => {
          startAction(async () => {
            const result = await approveExclusionRequest(commentId, projectId);
            if (result.error) toast.error(result.error);
            else {
              toast.success("Documento excluído");
              refresh();
            }
          });
        }}
      >
        Aprovar e excluir
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-6 text-xs"
        disabled={isPending}
        onClick={() => setShowRejectInput(true)}
      >
        Rejeitar
      </Button>
    </div>
  );
}
