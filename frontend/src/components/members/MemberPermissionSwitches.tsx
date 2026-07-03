"use client";

import { Switch } from "@/components/ui/switch";
import type { MemberRow } from "./member-list-utils";

interface MemberPermissionSwitchesProps {
  member: MemberRow;
  pendingArbitrateId: string | null;
  pendingResolveId: string | null;
  pendingCompareId: string | null;
  onToggleArbitrate: (memberId: string, value: boolean) => void;
  onToggleResolve: (memberId: string, value: boolean) => void;
  onToggleCompare: (memberId: string, value: boolean) => void;
}

export function MemberPermissionSwitches({
  member,
  pendingArbitrateId,
  pendingResolveId,
  pendingCompareId,
  onToggleArbitrate,
  onToggleResolve,
  onToggleCompare,
}: MemberPermissionSwitchesProps) {
  return (
    <>
      <span
        className="flex items-center gap-2 text-xs text-muted-foreground"
        title="Pode marcar dificuldades LLM e comentários de outros pesquisadores como resolvidos"
      >
        <Switch
          checked={member.can_resolve}
          onCheckedChange={(v) => onToggleResolve(member.id, v)}
          disabled={pendingResolveId === member.id}
          aria-label="Pode resolver pendências"
        />
        Resolve
      </span>
      <span
        className="flex items-center gap-2 text-xs text-muted-foreground"
        title="Recebe casos contestados para arbitrar"
      >
        <Switch
          checked={member.can_arbitrate}
          onCheckedChange={(v) => onToggleArbitrate(member.id, v)}
          disabled={pendingArbitrateId === member.id}
          aria-label="Elegível para arbitrar"
        />
        Arbitra
      </span>
      <span
        className="flex items-center gap-2 text-xs text-muted-foreground"
        title="Recebe documentos divergentes para comparar"
      >
        <Switch
          checked={member.can_compare}
          onCheckedChange={(v) => onToggleCompare(member.id, v)}
          disabled={pendingCompareId === member.id}
          aria-label="Elegível para comparar"
        />
        Compara
      </span>
    </>
  );
}
