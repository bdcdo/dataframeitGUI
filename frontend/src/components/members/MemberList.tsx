"use client";

import { useOptimistic, useTransition } from "react";
import {
  removeMember,
  changeRole,
  setCanArbitrate,
  setCanResolve,
  setCanCompare,
  unlinkMemberEmail,
} from "@/actions/members";
import { LinkEmailDialog } from "@/components/members/LinkEmailDialog";
import { UnifyMembersDialog } from "@/components/members/UnifyMembersDialog";
import { toast } from "sonner";
import type { MemberEmailLink } from "@/lib/types";
import { useMemberListDialogs } from "@/hooks/useMemberListDialogs";
import { MemberRow } from "./MemberRow";
import {
  memberDisplayName,
  groupLinksByMember,
  type MemberRow as MemberRowData,
} from "./member-list-utils";
import { buildRetriableToggleMessage, useTogglePermission } from "./useTogglePermission";

interface MemberListProps {
  projectId: string;
  members: MemberRowData[];
  emailLinks: MemberEmailLink[];
  currentUserId: string;
}

export function MemberList({
  projectId,
  members,
  emailLinks,
  currentUserId,
}: MemberListProps) {
  const {
    editingEmailMemberId,
    setEditingEmailMemberId,
    linkingMember,
    setLinkingMember,
    unify,
    setUnify,
  } = useMemberListDialogs();
  const [, startTransition] = useTransition();

  const linksByMember = groupLinksByMember(emailLinks);

  const handleUnlink = async (linkId: string) => {
    const result = await unlinkMemberEmail(projectId, linkId);
    if (result?.error) {
      toast.error(result.error);
    } else {
      toast.success("E-mail desvinculado. Acessos futuros por ele cessam; o histórico permanece.");
    }
  };

  // useOptimistic: o Switch reflete imediatamente o valor escolhido enquanto o
  // server action roda. Sem isso, o `checked` permanece no valor antigo até o
  // revalidatePath devolver — em conexão lenta parece que o clique não pegou.
  const [optimisticMembers, applyOptimistic] = useOptimistic<
    MemberRowData[],
    { memberId: string; patch: Partial<Pick<MemberRowData, "can_arbitrate" | "can_resolve" | "can_compare">> }
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

  const arbitrate = useTogglePermission(
    projectId,
    setCanArbitrate,
    (value) => ({ can_arbitrate: value }),
    (value, retried) =>
      buildRetriableToggleMessage(
        `Arbitragem ${value ? "habilitada" : "desabilitada"}`,
        "árbitro",
        retried,
      ),
    applyOptimistic,
    startTransition,
  );
  const resolve = useTogglePermission(
    projectId,
    setCanResolve,
    (value) => ({ can_resolve: value }),
    (value) =>
      value ? "Permissão para resolver habilitada." : "Permissão para resolver desabilitada.",
    applyOptimistic,
    startTransition,
  );
  const compare = useTogglePermission(
    projectId,
    setCanCompare,
    (value) => ({ can_compare: value }),
    (value, retried) =>
      buildRetriableToggleMessage(
        `Comparação ${value ? "habilitada" : "desabilitada"}`,
        "revisor",
        retried,
      ),
    applyOptimistic,
    startTransition,
  );

  return (
    <div className="space-y-2">
      {optimisticMembers.map((m) => (
        <MemberRow
          key={m.id}
          member={m}
          projectId={projectId}
          currentUserId={currentUserId}
          links={linksByMember.get(m.user_id) ?? []}
          editingEmailMemberId={editingEmailMemberId}
          onEditingEmailChange={setEditingEmailMemberId}
          onLinkEmail={setLinkingMember}
          onUnlinkEmailLink={(linkId) => void handleUnlink(linkId)}
          pendingArbitrateId={arbitrate.pendingId}
          pendingResolveId={resolve.pendingId}
          pendingCompareId={compare.pendingId}
          onToggleArbitrate={arbitrate.toggle}
          onToggleResolve={resolve.toggle}
          onToggleCompare={compare.toggle}
          onChangeRole={(memberId, newRole) => void handleChangeRole(memberId, newRole)}
          onRemove={(memberId) => void handleRemove(memberId)}
        />
      ))}
      {linkingMember && (
        <LinkEmailDialog
          projectId={projectId}
          memberUserId={linkingMember.user_id}
          memberName={memberDisplayName(linkingMember)}
          open={true}
          onOpenChange={(open) => {
            if (!open) setLinkingMember(null);
          }}
          onRequiresUnification={(preview) => {
            setUnify({ preview, targetName: memberDisplayName(linkingMember) });
            setLinkingMember(null);
          }}
        />
      )}
      <UnifyMembersDialog
        projectId={projectId}
        preview={unify?.preview ?? null}
        targetName={unify?.targetName ?? ""}
        onClose={() => setUnify(null)}
      />
    </div>
  );
}
