"use client";

import { useState } from "react";
import { updatePendingMemberEmail } from "@/actions/members";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import type { MemberRow } from "./member-list-utils";

interface EditPendingEmailDialogProps {
  projectId: string;
  member: MemberRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Correção de e-mail digitado errado num pré-registro (FR-005). Só aparece
// para membros pendentes; depois da ativação a correção é via vínculo (US2).
export function EditPendingEmailDialog({
  projectId,
  member,
  open,
  onOpenChange,
}: EditPendingEmailDialogProps) {
  const [email, setEmail] = useState(member.profiles?.email ?? "");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    const result = await updatePendingMemberEmail(projectId, member.user_id, email);
    setSaving(false);
    if (result.error) {
      toast.error(result.error);
      return;
    }
    if (result.otherProjectsCount && result.otherProjectsCount > 0) {
      toast.success(
        `E-mail corrigido. A correção também vale para ${result.otherProjectsCount} outro(s) projeto(s) em que este membro está pré-registrado.`,
      );
    } else {
      toast.success("E-mail corrigido.");
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Corrigir e-mail do membro pendente</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            O membro ainda não criou conta. O novo e-mail passa a valer para o
            pré-registro — em todos os projetos em que ele foi adicionado.
          </p>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="novo-email@exemplo.com"
          />
          <Button
            onClick={() => void handleSave()}
            disabled={saving || !email}
            className="w-full bg-brand hover:bg-brand/90 text-brand-foreground"
          >
            {saving ? "Salvando..." : "Salvar"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
