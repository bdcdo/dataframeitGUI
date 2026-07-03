"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { linkMemberEmail, type UnificationPreview } from "@/actions/members";
import { toast } from "sonner";

interface LinkEmailDialogProps {
  projectId: string;
  memberUserId: string;
  memberName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Caso 2 do contrato: o e-mail é o principal de outro membro — a decisão
  // passa para o UnifyMembersDialog com o preview retornado pela action.
  onRequiresUnification: (preview: UnificationPreview) => void;
}

export function LinkEmailDialog({
  projectId,
  memberUserId,
  memberName,
  open,
  onOpenChange,
  onRequiresUnification,
}: LinkEmailDialogProps) {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLink = async () => {
    setLoading(true);
    const result = await linkMemberEmail(projectId, memberUserId, email);
    setLoading(false);

    if (result.error) {
      toast.error(result.error);
      return;
    }
    if (result.requiresUnification) {
      onOpenChange(false);
      setEmail("");
      onRequiresUnification(result.requiresUnification);
      return;
    }
    if (result.link) {
      toast.success(
        result.link.linked_user_id
          ? "E-mail vinculado. A conta passa a acessar o projeto como este membro."
          : "E-mail vinculado. Quando a conta for criada com este e-mail, ela entrará no projeto como este membro.",
      );
      setEmail("");
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Vincular e-mail a {memberName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Qualquer conta com um e-mail vinculado acessa este projeto como o
            mesmo membro, com as mesmas atribuições. O vínculo vale só para
            este projeto.
          </p>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="email-adicional@exemplo.com"
          />
          <Button
            onClick={() => void handleLink()}
            disabled={loading || !email}
            className="w-full bg-brand hover:bg-brand/90 text-brand-foreground"
          >
            {loading ? "Vinculando..." : "Vincular"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
