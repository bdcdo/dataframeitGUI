"use client";

import { useRef, useState } from "react";
import { Loader2 } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { memberDisplayName, type MemberRow } from "./member-list-utils";

interface MemberRoleControlsProps {
  member: MemberRow;
  effectiveUserId: string;
  onChangeRole: (memberId: string, newRole: "coordenador" | "pesquisador") => void;
  onRemove: (memberId: string) => Promise<boolean>;
}

export function MemberRoleControls({
  member,
  effectiveUserId,
  onChangeRole,
  onRemove,
}: MemberRoleControlsProps) {
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const removeInFlight = useRef(false);
  const displayName = memberDisplayName(member);
  const email = member.profiles?.email;

  const handleConfirmRemove = async () => {
    // O ref fecha a janela entre o clique e o primeiro rerender, durante a qual
    // dois eventos poderiam iniciar a mesma Server Action.
    if (removeInFlight.current) return;

    removeInFlight.current = true;
    setIsRemoving(true);
    try {
      const removed = await onRemove(member.id);
      if (removed) setRemoveDialogOpen(false);
    } finally {
      removeInFlight.current = false;
      setIsRemoving(false);
    }
  };

  return (
    <>
      <Select
        value={member.role}
        onValueChange={(v) => onChangeRole(member.id, v as "coordenador" | "pesquisador")}
        disabled={member.user_id === effectiveUserId}
      >
        <SelectTrigger className="h-8 w-[140px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="coordenador">Coordenador</SelectItem>
          <SelectItem value="pesquisador">Pesquisador</SelectItem>
        </SelectContent>
      </Select>
      {member.user_id !== effectiveUserId && (
        <AlertDialog
          open={removeDialogOpen}
          onOpenChange={(open) => {
            if (!isRemoving) setRemoveDialogOpen(open);
          }}
        >
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="sm" className="text-destructive">
              Remover
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remover membro?</AlertDialogTitle>
              <AlertDialogDescription>
                Tem certeza de que deseja remover <strong>{displayName}</strong>
                {email && email !== displayName ? <> ({email})</> : null} deste projeto?
                As atribuições ainda não iniciadas voltarão ao conjunto disponível.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isRemoving}>
                Cancelar
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={isRemoving}
                aria-busy={isRemoving}
                onClick={(event) => {
                  // AlertDialogAction fecha por padrão. O resultado da action é
                  // quem decide: sucesso fecha; erro preserva o diálogo para retry.
                  event.preventDefault();
                  void handleConfirmRemove();
                }}
              >
                {isRemoving ? (
                  <>
                    <Loader2 aria-hidden="true" className="mr-1.5 size-3.5 animate-spin" />
                    Removendo…
                  </>
                ) : (
                  "Remover"
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}
