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
import { ConfirmActionDialog } from "@/components/ui/confirm-action-dialog";
import { LinkEmailDialog } from "@/components/members/LinkEmailDialog";
import { UnifyMembersDialog } from "@/components/members/UnifyMembersDialog";
import { toast } from "sonner";
import { useMemberListDialogs } from "@/hooks/useMemberListDialogs";
import { MemberRow } from "./MemberRow";
import {
  memberDisplayName,
  memberSecondaryEmail,
  groupLinksByMember,
  type MemberEmailLinkView,
  type MemberRow as MemberRowData,
} from "./member-list-utils";
import {
  buildRetriableToggleMessage,
  useTogglePermission,
} from "./useTogglePermission";

interface MemberListProps {
  projectId: string;
  members: MemberRowData[];
  emailLinks: MemberEmailLinkView[];
  currentUserId: string;
}

async function changeRoleWithToast(
  memberId: string,
  newRole: "coordenador" | "pesquisador",
) {
  const result = await changeRole(memberId, newRole);
  if (result?.error) {
    toast.error(result.error);
  } else {
    toast.success("Papel atualizado");
  }
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
    removingMember,
    setRemovingMember,
  } = useMemberListDialogs();
  const [, startTransition] = useTransition();
  const [isRemoving, startRemoving] = useTransition();

  const linksByMember = groupLinksByMember(emailLinks);

  const handleUnlink = async (linkId: string) => {
    const result = await unlinkMemberEmail(projectId, linkId);
    if (result?.error) {
      toast.error(result.error);
    } else {
      toast.success(
        "E-mail desvinculado. Acessos futuros por ele cessam; o histórico permanece.",
      );
    }
  };

  // A remoção é irreversível para o trabalho pendente do membro, então só o
  // sucesso fecha o diálogo: erro e falha de rede mantêm a confirmação em cena
  // para o coordenador tentar de novo sem reabrir e reencontrar a linha.
  const confirmRemove = () => {
    if (!removingMember) return;
    const memberId = removingMember.id;
    startRemoving(async () => {
      try {
        const result = await removeMember(memberId);
        if (result?.error) {
          toast.error(result.error);
          return;
        }
        toast.success("Membro removido");
        setRemovingMember(null);
      } catch (error) {
        console.error("[MemberList] erro ao remover membro", error);
        toast.error("Não foi possível remover o membro. Tente novamente.");
      }
    });
  };

  // useOptimistic: o Switch reflete imediatamente o valor escolhido enquanto o
  // server action roda. Sem isso, o `checked` permanece no valor antigo até o
  // revalidatePath devolver — em conexão lenta parece que o clique não pegou.
  const [optimisticMembers, applyOptimistic] = useOptimistic<
    MemberRowData[],
    {
      memberId: string;
      patch: Partial<
        Pick<MemberRowData, "can_arbitrate" | "can_resolve" | "can_compare">
      >;
    }
  >(members, (current, update) =>
    current.map((m) =>
      m.id === update.memberId ? { ...m, ...update.patch } : m,
    ),
  );

  const arbitrate = useTogglePermission(
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
    setCanResolve,
    (value) => ({ can_resolve: value }),
    (value) =>
      value
        ? "Permissão para resolver habilitada."
        : "Permissão para resolver desabilitada.",
    applyOptimistic,
    startTransition,
  );
  const compare = useTogglePermission(
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

  const removalName = removingMember ? memberDisplayName(removingMember) : null;
  const removalEmail = removingMember
    ? memberSecondaryEmail(removingMember)
    : null;

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
          onChangeRole={(memberId, newRole) =>
            void changeRoleWithToast(memberId, newRole)
          }
          onRequestRemove={setRemovingMember}
        />
      ))}
      <ConfirmActionDialog
        open={!!removingMember}
        onClose={() => setRemovingMember(null)}
        title="Remover membro?"
        description={
          removalName ? (
            <>
              Remover <strong>{removalName}</strong>
              {removalEmail ? <> ({removalEmail})</> : null} deste projeto? As
              atribuições ainda não iniciadas voltam ao conjunto disponível; o
              trabalho já feito permanece como histórico.
            </>
          ) : null
        }
        confirmLabel="Remover"
        pendingLabel="Removendo…"
        destructive
        isPending={isRemoving}
        onConfirm={confirmRemove}
      />
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
