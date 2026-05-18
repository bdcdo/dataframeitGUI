"use client";

import { useTransition } from "react";
import { removeMember, changeRole, setCanArbitrate } from "@/actions/members";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import type { ProjectMember, Profile } from "@/lib/types";

interface MemberListProps {
  projectId: string;
  members: (ProjectMember & { profiles: Profile | null })[];
  currentUserId: string;
}

export function MemberList({ projectId, members, currentUserId }: MemberListProps) {
  const [isPending, startTransition] = useTransition();

  const handleRemove = async (memberId: string) => {
    const result = await removeMember(projectId, memberId);
    if (result?.error) {
      toast.error(result.error);
    } else {
      toast.success("Membro removido");
    }
  };

  const handleChangeRole = async (memberId: string, newRole: "coordenador" | "pesquisador") => {
    const result = await changeRole(memberId, newRole, projectId);
    if (result?.error) {
      toast.error(result.error);
    } else {
      toast.success("Papel atualizado");
    }
  };

  const handleToggleArbitrate = (memberId: string, value: boolean) => {
    startTransition(async () => {
      const result = await setCanArbitrate(memberId, value, projectId);
      if (result?.error) {
        toast.error(result.error);
        return;
      }
      if (value && result.retried && result.retried.assigned > 0) {
        toast.success(
          `Arbitragem habilitada. ${result.retried.assigned} caso(s) pendente(s) alocados.`,
        );
      } else if (value) {
        toast.success("Arbitragem habilitada.");
      } else {
        toast.success("Arbitragem desabilitada.");
      }
    });
  };

  return (
    <div className="space-y-2">
      {members.map((m) => (
        <div key={m.id} className="flex items-center justify-between rounded-lg border p-3">
          <div>
            <p className="text-sm font-medium">
              {m.profiles?.first_name || m.profiles?.email || "Sem perfil"}
            </p>
            <p className="text-xs text-muted-foreground">{m.profiles?.email}</p>
          </div>
          <div className="flex items-center gap-3">
            <label
              className="flex items-center gap-2 text-xs text-muted-foreground"
              title="Recebe casos contestados para arbitrar"
            >
              <Switch
                checked={m.can_arbitrate}
                onCheckedChange={(v) => handleToggleArbitrate(m.id, v)}
                disabled={isPending}
                aria-label="Elegível para arbitrar"
              />
              Arbitra
            </label>
            <Select
              value={m.role}
              onValueChange={(v) => handleChangeRole(m.id, v as "coordenador" | "pesquisador")}
              disabled={m.user_id === currentUserId}
            >
              <SelectTrigger className="h-8 w-[140px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="coordenador">Coordenador</SelectItem>
                <SelectItem value="pesquisador">Pesquisador</SelectItem>
              </SelectContent>
            </Select>
            {m.user_id !== currentUserId && (
              <Button variant="ghost" size="sm" onClick={() => handleRemove(m.id)} className="text-destructive">
                Remover
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
