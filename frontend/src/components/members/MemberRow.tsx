"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EditPendingEmailDialog } from "./EditPendingEmailDialog";
import { MemberEmailLinks } from "./MemberEmailLinks";
import { MemberPermissionSwitches } from "./MemberPermissionSwitches";
import { MemberRoleControls } from "./MemberRoleControls";
import {
  memberDisplayName,
  type MemberEmailLinkView,
  type MemberRow as MemberRowData,
} from "./member-list-utils";

interface MemberRowProps {
  member: MemberRowData;
  projectId: string;
  currentUserId: string;
  links: MemberEmailLinkView[];
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
  onChangeRole: (
    memberId: string,
    newRole: "coordenador" | "pesquisador",
  ) => void;
  onRequestRemove: (member: MemberRowData) => void;
}

export function MemberRow({
  member,
  projectId,
  currentUserId,
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
  onRequestRemove,
}: MemberRowProps) {
  const isProjectPending = member.accessState === "pending";
  const isAccessUnavailable = member.accessState === "unavailable";

  return (
    // Os controles descem para a linha de baixo quando não cabem ao lado do
    // nome, em vez de sair do card.
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border p-3">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm font-medium">
          {memberDisplayName(member)}
          {isProjectPending && (
            <Badge
              variant="secondary"
              title="Pré-registrado: ainda não criou conta. Entra no projeto no primeiro acesso."
            >
              Pendente
            </Badge>
          )}
          {isAccessUnavailable && (
            <Badge
              variant="secondary"
              title="A conta existe, mas o acesso está revogado ou ainda não concluiu a sincronização."
            >
              Sem acesso
            </Badge>
          )}
        </p>
        <p className="break-all text-xs text-muted-foreground">
          {member.profiles?.email}
        </p>
        <MemberEmailLinks links={links} onUnlink={onUnlinkEmailLink} />
      </div>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
        <Button variant="ghost" size="sm" onClick={() => onLinkEmail(member)}>
          Vincular e-mail
        </Button>
        {member.isClaimable && (
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
              onOpenChange={(open) =>
                onEditingEmailChange(open ? member.id : null)
              }
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
          currentUserId={currentUserId}
          onChangeRole={onChangeRole}
          onRequestRemove={onRequestRemove}
        />
      </div>
    </div>
  );
}
