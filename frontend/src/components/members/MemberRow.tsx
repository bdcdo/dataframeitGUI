"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { MemberEmailLink } from "@/lib/types";
import { EditPendingEmailDialog } from "./EditPendingEmailDialog";
import { MemberEmailLinks } from "./MemberEmailLinks";
import { MemberPermissionSwitches } from "./MemberPermissionSwitches";
import { MemberRoleControls } from "./MemberRoleControls";
import { memberDisplayName, type MemberRow as MemberRowData } from "./member-list-utils";

interface MemberRowProps {
  member: MemberRowData;
  projectId: string;
  effectiveUserId: string;
  links: MemberEmailLink[];
  editingEmailMemberId: string | null;
  onEditingEmailChange: (memberId: string | null) => void;
  onLinkEmail: (member: MemberRowData) => void;
  onUnlinkEmailLink: (linkId: string) => void;
  pendingArbitrateId: string | null;
  pendingResolveId: string | null;
  pendingCompareId: string | null;
  onToggleArbitrate: (memberId: string, value: boolean) => void;
  onToggleResolve: (memberId: string, value: boolean) => void;
  onToggleCompare: (memberId: string, value: boolean) => void;
  onChangeRole: (memberId: string, newRole: "coordenador" | "pesquisador") => void;
  onRemove: (memberId: string) => Promise<boolean>;
}

export function MemberRow({
  member,
  projectId,
  effectiveUserId,
  links,
  editingEmailMemberId,
  onEditingEmailChange,
  onLinkEmail,
  onUnlinkEmailLink,
  pendingArbitrateId,
  pendingResolveId,
  pendingCompareId,
  onToggleArbitrate,
  onToggleResolve,
  onToggleCompare,
  onChangeRole,
  onRemove,
}: MemberRowProps) {
  const isPending = member.profiles && member.profiles.activated_at === null;

  return (
    <div className="flex items-center justify-between rounded-lg border p-3">
      <div>
        <p className="flex items-center gap-2 text-sm font-medium">
          {memberDisplayName(member)}
          {isPending && (
            <Badge
              variant="secondary"
              title="Pré-registrado: ainda não criou conta. Entra no projeto no primeiro acesso."
            >
              Pendente
            </Badge>
          )}
        </p>
        <p className="text-xs text-muted-foreground">{member.profiles?.email}</p>
        <MemberEmailLinks links={links} onUnlink={onUnlinkEmailLink} />
      </div>
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => onLinkEmail(member)}>
          Vincular e-mail
        </Button>
        {isPending && (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onEditingEmailChange(member.id)}
            >
              Corrigir e-mail
            </Button>
            <EditPendingEmailDialog
              projectId={projectId}
              member={member}
              open={editingEmailMemberId === member.id}
              onOpenChange={(open) => onEditingEmailChange(open ? member.id : null)}
            />
          </>
        )}
        <MemberPermissionSwitches
          member={member}
          pendingArbitrateId={pendingArbitrateId}
          pendingResolveId={pendingResolveId}
          pendingCompareId={pendingCompareId}
          onToggleArbitrate={onToggleArbitrate}
          onToggleResolve={onToggleResolve}
          onToggleCompare={onToggleCompare}
        />
        <MemberRoleControls
          member={member}
          effectiveUserId={effectiveUserId}
          onChangeRole={onChangeRole}
          onRemove={onRemove}
        />
      </div>
    </div>
  );
}
