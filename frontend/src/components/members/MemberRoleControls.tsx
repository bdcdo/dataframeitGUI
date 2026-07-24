"use client";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { MemberRow } from "./member-list-utils";

interface MemberRoleControlsProps {
  member: MemberRow;
  currentUserId: string;
  onChangeRole: (memberId: string, newRole: "coordenador" | "pesquisador") => void;
  onRequestRemove: (member: MemberRow) => void;
}

export function MemberRoleControls({
  member,
  currentUserId,
  onChangeRole,
  onRequestRemove,
}: MemberRoleControlsProps) {
  return (
    <>
      <Select
        value={member.role}
        onValueChange={(v) => onChangeRole(member.id, v as "coordenador" | "pesquisador")}
        disabled={member.user_id === currentUserId}
      >
        <SelectTrigger className="h-8 w-[140px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="coordenador">Coordenador</SelectItem>
          <SelectItem value="pesquisador">Pesquisador</SelectItem>
        </SelectContent>
      </Select>
      {member.user_id !== currentUserId && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onRequestRemove(member)}
          className="text-destructive"
        >
          Remover
        </Button>
      )}
    </>
  );
}
