"use client";

import { useState, useTransition } from "react";
import { Flag, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { requestDocumentExclusion } from "@/actions/project-comments";
import { toast } from "sonner";

interface SuggestExclusionDialogProps {
  projectId: string;
  documentId: string;
  documentTitle?: string;
  /** botao no header e icon-only com tooltip */
  iconOnly?: boolean;
}

export function SuggestExclusionDialog({
  projectId,
  documentId,
  documentTitle,
  iconOnly = false,
}: SuggestExclusionDialogProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [isPending, startTransition] = useTransition();

  function handleSubmit() {
    if (!reason.trim()) {
      toast.error("Informe o motivo da sugestão");
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
          "Sugestão enviada — coordenador será notificado em Comentários",
        );
        setOpen(false);
        setReason("");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {iconOnly ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title="Sinalizar fora de escopo"
          >
            <Flag className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button variant="outline" size="sm">
            <Flag className="mr-1.5 h-3.5 w-3.5" />
            Sinalizar fora de escopo
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sinalizar documento fora de escopo</DialogTitle>
          <DialogDescription>
            Sua sugestão será enviada ao coordenador. Se aprovada, o documento
            é removido das suas atribuições e da listagem do projeto.
            {documentTitle && (
              <span className="mt-1 block text-foreground">
                <strong>{documentTitle}</strong>
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="exclusion-reason">
            Por que parece fora de escopo?{" "}
            <span className="text-destructive">*</span>
          </Label>
          <Textarea
            id="exclusion-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ex: parecer trata de medicamento diferente do estudado"
            rows={4}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={isPending}
          >
            Cancelar
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isPending || !reason.trim()}
          >
            {isPending ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                Enviando…
              </>
            ) : (
              "Enviar sugestão"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
