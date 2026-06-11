"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { unifyMembers, type UnificationPreview } from "@/actions/members";
import { toast } from "sonner";

interface UnifyMembersDialogProps {
  projectId: string;
  // null = dialog fechado
  preview: UnificationPreview | null;
  targetName: string;
  onClose: () => void;
}

// Confirmação explícita da unificação (FR-009), com o impacto calculado pela
// action e o aviso de permanência (clarificação Q1 da spec).
export function UnifyMembersDialog({
  projectId,
  preview,
  targetName,
  onClose,
}: UnifyMembersDialogProps) {
  const [loading, setLoading] = useState(false);

  const handleUnify = async () => {
    if (!preview) return;
    setLoading(true);
    const result = await unifyMembers(
      projectId,
      preview.sourceUserId,
      preview.targetUserId,
    );
    setLoading(false);
    if (result.error) {
      toast.error(result.error);
      return;
    }
    toast.success(
      `Membros unificados. ${preview.sourceName} agora atua como ${targetName} neste projeto.`,
    );
    onClose();
  };

  return (
    <Dialog open={preview !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Unificar membros</DialogTitle>
        </DialogHeader>
        {preview && (
          <div className="space-y-4">
            <p className="text-sm">
              Este e-mail é o principal de <strong>{preview.sourceName}</strong>
              , que já é membro do projeto. Vincular significa unificar os dois
              membros: <strong>{preview.sourceName}</strong> passa a atuar como{" "}
              <strong>{targetName}</strong>.
            </p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              <li>
                {preview.assignmentsToMigrate} atribuição(ões) de{" "}
                {preview.sourceName} migram para {targetName}.
              </li>
              <li>
                {preview.docsWithBothResponses} documento(s) têm resposta
                vigente de ambos — a mais recente prevalece; a outra vira
                histórico (afeta comparações).
              </li>
              <li>
                Papel e permissões resultantes: os de {targetName} (
                {preview.resultingRole}).
              </li>
            </ul>
            <p className="text-sm font-medium text-destructive">
              A unificação é permanente e não pode ser desfeita.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose} disabled={loading}>
                Cancelar
              </Button>
              <Button
                onClick={handleUnify}
                disabled={loading}
                className="bg-brand hover:bg-brand/90 text-brand-foreground"
              >
                {loading ? "Unificando..." : "Unificar membros"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
