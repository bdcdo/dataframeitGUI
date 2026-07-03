"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  requestDocumentExclusion,
  cancelExclusionRequest,
} from "@/actions/project-comments";
import { toast } from "sonner";

export type OutOfScopeStatus = "normal" | "pending_mine" | "pending_other";

export interface OutOfScopeState {
  status: OutOfScopeStatus;
  reason?: string;
}

interface OutOfScopeToggleProps {
  projectId: string;
  documentId: string;
  documentTitle?: string;
  state: OutOfScopeState;
  onStateChange: (next: OutOfScopeState) => void;
  disabled?: boolean;
}

/**
 * Pergunta "Documento fora do escopo?" no topo do formulário de codificação.
 * Ligar abre o dialog de justificativa; confirmar cria o exclusion_request
 * (o doc some das filas dos demais na hora — trigger no banco) e bloqueia o
 * formulário até o coordenador decidir em Comentários. Quem sinalizou pode
 * desligar para cancelar o pedido enquanto pendente.
 */
export function OutOfScopeToggle({
  projectId,
  documentId,
  documentTitle,
  state,
  onStateChange,
  disabled = false,
}: OutOfScopeToggleProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const pending = state.status !== "normal";
  const interactive = !disabled && state.status !== "pending_other";

  function handleCheckedChange(checked: boolean) {
    if (!interactive || isPending) return;
    if (checked) {
      setDialogOpen(true);
      return;
    }
    // Desligar = cancelar o próprio pedido pendente.
    startTransition(async () => {
      const result = await cancelExclusionRequest(projectId, documentId);
      if (result?.error) {
        toast.error(result.error);
      } else {
        toast.success("Sinalização cancelada — documento volta às filas");
        onStateChange({ status: "normal" });
        router.refresh();
      }
    });
  }

  function handleConfirm() {
    if (!reason.trim()) {
      toast.error("Informe o motivo da sinalização");
      return;
    }
    startTransition(async () => {
      const result = await requestDocumentExclusion(
        projectId,
        documentId,
        reason,
      );
      if (result?.error) {
        toast.error(result.error);
      } else {
        toast.success(
          "Documento sinalizado — coordenador revisará em Comentários",
        );
        onStateChange({ status: "pending_mine", reason: reason.trim() });
        setDialogOpen(false);
        setReason("");
        router.refresh();
      }
    });
  }

  return (
    <div
      className={
        pending
          ? "rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2.5"
          : "rounded-md border px-3 py-2.5"
      }
    >
      <div className="flex items-start gap-3">
        <Switch
          id="out-of-scope"
          checked={pending}
          onCheckedChange={handleCheckedChange}
          disabled={!interactive || isPending}
          aria-label="Documento fora do escopo"
        />
        <div className="min-w-0 space-y-1">
          <Label htmlFor="out-of-scope" className="text-sm font-medium">
            Documento fora do escopo?
          </Label>
          {state.status === "normal" && (
            <p className="text-xs text-muted-foreground">
              Marque se este documento não pertence ao estudo. Ele sai das
              filas de todos e vai para revisão do coordenador — sem precisar
              preencher as perguntas.
            </p>
          )}
          {state.status === "pending_mine" && (
            <p className="text-xs text-muted-foreground">
              Aguardando revisão do coordenador.
              {state.reason && (
                <>
                  {" "}
                  Sua justificativa: <em>{state.reason}</em>.
                </>
              )}{" "}
              Desligue para cancelar a sinalização.
            </p>
          )}
          {state.status === "pending_other" && (
            <p className="text-xs text-muted-foreground">
              Sinalizado como fora de escopo por outro pesquisador — aguardando
              revisão do coordenador.
            </p>
          )}
        </div>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sinalizar documento fora de escopo</DialogTitle>
            <DialogDescription>
              O documento sai imediatamente das filas de codificação e da
              Comparação de todos, e o coordenador decide em Comentários:
              aprovar remove da base; rejeitar devolve às filas.
              {documentTitle && (
                <span className="mt-1 block text-foreground">
                  <strong>{documentTitle}</strong>
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="out-of-scope-reason">
              Por que está fora do escopo?{" "}
              <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="out-of-scope-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ex: parecer trata de medicamento diferente do estudado"
              rows={4}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={isPending}
            >
              Cancelar
            </Button>
            <Button onClick={handleConfirm} disabled={isPending || !reason.trim()}>
              {isPending ? (
                <>
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                  Enviando…
                </>
              ) : (
                "Sinalizar fora de escopo"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
