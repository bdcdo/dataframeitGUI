"use client";

import { useOptimistic, useState, useTransition } from "react";
import { removeMember, changeRole, setCanArbitrate, setCanResolve } from "@/actions/members";
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

type MemberRow = ProjectMember & { profiles: Profile | null };

export function MemberList({ projectId, members, currentUserId }: MemberListProps) {
  // Per-row + per-switch pending: o Switch tocado fica disabled até o server
  // action retornar, mas o outro Switch da mesma linha e os Switches das demais
  // linhas continuam interativos. Coordenador habilitando 4 membros em
  // sequência não precisa esperar serializar.
  const [pendingArbitrateId, setPendingArbitrateId] = useState<string | null>(null);
  const [pendingResolveId, setPendingResolveId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // useOptimistic: o Switch reflete imediatamente o valor escolhido enquanto o
  // server action roda. Sem isso, o `checked` permanece no valor antigo até o
  // revalidatePath devolver — em conexão lenta parece que o clique não pegou.
  const [optimisticMembers, applyOptimistic] = useOptimistic<
    MemberRow[],
    { memberId: string; patch: Partial<Pick<MemberRow, "can_arbitrate" | "can_resolve">> }
  >(members, (current, update) =>
    current.map((m) =>
      m.id === update.memberId ? { ...m, ...update.patch } : m,
    ),
  );

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
    setPendingArbitrateId(memberId);
    startTransition(async () => {
      applyOptimistic({ memberId, patch: { can_arbitrate: value } });
      try {
        const result = await setCanArbitrate(memberId, value, projectId);
        if (result?.error) {
          toast.error(result.error);
          return;
        }
        if (!value) {
          toast.success("Arbitragem desabilitada.");
          return;
        }
        const retried = result.retried;
        if (retried && retried.assigned > 0 && retried.stillNoPool > 0) {
          toast.success(
            `Arbitragem habilitada. ${retried.assigned} caso(s) alocado(s); ${retried.stillNoPool} ainda sem árbitro elegível.`,
          );
        } else if (retried && retried.assigned > 0) {
          toast.success(
            `Arbitragem habilitada. ${retried.assigned} caso(s) pendente(s) alocado(s).`,
          );
        } else {
          toast.success("Arbitragem habilitada.");
        }
      } finally {
        setPendingArbitrateId(null);
      }
    });
  };

  const handleToggleResolve = (memberId: string, value: boolean) => {
    setPendingResolveId(memberId);
    startTransition(async () => {
      applyOptimistic({ memberId, patch: { can_resolve: value } });
      try {
        const result = await setCanResolve(memberId, value, projectId);
        if (result?.error) {
          toast.error(result.error);
          return;
        }
        toast.success(
          value
            ? "Permissão para resolver habilitada."
            : "Permissão para resolver desabilitada.",
        );
      } finally {
        setPendingResolveId(null);
      }
    });
  };

  return (
    <div className="space-y-2">
      {optimisticMembers.map((m) => (
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
              title="Pode marcar dificuldades LLM e comentários de outros pesquisadores como resolvidos"
            >
              <Switch
                checked={m.can_resolve}
                onCheckedChange={(v) => handleToggleResolve(m.id, v)}
                disabled={pendingResolveId === m.id}
                aria-label="Pode resolver pendências"
              />
              Resolve
            </label>
            <label
              className="flex items-center gap-2 text-xs text-muted-foreground"
              title="Recebe casos contestados para arbitrar"
            >
              <Switch
                checked={m.can_arbitrate}
                onCheckedChange={(v) => handleToggleArbitrate(m.id, v)}
                disabled={pendingArbitrateId === m.id}
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
