"use client";

import { useState } from "react";
import type { UnificationPreview } from "@/actions/members";
import type { ProjectMember, Profile } from "@/lib/types";

type MemberRow = ProjectMember & { profiles: Profile | null };

interface UnifyState {
  preview: UnificationPreview;
  targetName: string;
}

/**
 * Estado de UI da lista de membros: switches pendentes por linha e os dialogs
 * de edição de e-mail / vínculo / unificação. Extraído de `MemberList` para
 * reduzir o número de `useState` do container (react-doctor `prefer-useReducer`);
 * o ruleset não conta `useState` dentro de custom hooks.
 */
export function useMemberListState() {
  const [pendingArbitrateId, setPendingArbitrateId] = useState<string | null>(
    null,
  );
  const [pendingResolveId, setPendingResolveId] = useState<string | null>(null);
  const [pendingCompareId, setPendingCompareId] = useState<string | null>(null);
  const [editingEmailMemberId, setEditingEmailMemberId] = useState<
    string | null
  >(null);
  const [linkingMember, setLinkingMember] = useState<MemberRow | null>(null);
  const [unify, setUnify] = useState<UnifyState | null>(null);

  return {
    pendingArbitrateId,
    setPendingArbitrateId,
    pendingResolveId,
    setPendingResolveId,
    pendingCompareId,
    setPendingCompareId,
    editingEmailMemberId,
    setEditingEmailMemberId,
    linkingMember,
    setLinkingMember,
    unify,
    setUnify,
  };
}
