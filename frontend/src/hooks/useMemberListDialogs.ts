import { useState } from "react";
import type { UnificationPreview } from "@/actions/members";
import type { MemberRow } from "@/components/members/member-list-utils";

// Agrupa os estados que controlam quais dialogs estão abertos em MemberList,
// extraídos do corpo do componente para manter a contagem de useState baixa.
// Os pending-ids dos Switches de permissão vivem em useTogglePermission (um
// por toggle), não aqui.
export function useMemberListDialogs() {
  const [editingEmailMemberId, setEditingEmailMemberId] = useState<string | null>(null);
  // Vínculo de e-mails (US2): um único par de dialogs no root, dirigido pelo
  // membro selecionado / preview de unificação retornado pela action.
  const [linkingMember, setLinkingMember] = useState<MemberRow | null>(null);
  const [unify, setUnify] = useState<{
    preview: UnificationPreview;
    targetName: string;
  } | null>(null);

  return {
    editingEmailMemberId,
    setEditingEmailMemberId,
    linkingMember,
    setLinkingMember,
    unify,
    setUnify,
  };
}
