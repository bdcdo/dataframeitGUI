"use client";

import { removeMember, changeRole } from "@/actions/members";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import type { ProjectMember, Profile } from "@/lib/types";

interface MemberListProps {
  projectId: string;
  members: (ProjectMember & { profiles: Profile | null })[];
  currentUserId: string;
}

export function MemberList({ projectId, members, currentUserId }: MemberListProps) {
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
          <div className="flex items-center gap-2">
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
