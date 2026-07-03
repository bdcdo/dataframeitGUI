import { useState, type TransitionStartFunction } from "react";
import { toast } from "sonner";
import type { MemberRow } from "./member-list-utils";

type RetryInfo = { assigned: number; stillNoPool: number };

type ToggleAction = (
  memberId: string,
  value: boolean,
  projectId: string
) => Promise<{ error?: string; retried?: RetryInfo }>;

// arbitrate/resolve/compare compartilham a mesma forma (optimistic update →
// server action → toast condicional em `retried` → cleanup no finally); só
// diferem na action chamada e na mensagem. setCanResolve nunca retorna
// `retried`, então buildSuccessMessage degrada para a mensagem simples nesse
// caso (branches de `retried.assigned > 0` nunca disparam).
export function useTogglePermission(
  projectId: string,
  action: ToggleAction,
  patch: (
    value: boolean
  ) => Partial<Pick<MemberRow, "can_arbitrate" | "can_resolve" | "can_compare">>,
  buildSuccessMessage: (value: boolean, retried?: RetryInfo) => string,
  applyOptimistic: (update: {
    memberId: string;
    patch: Partial<Pick<MemberRow, "can_arbitrate" | "can_resolve" | "can_compare">>;
  }) => void,
  startTransition: TransitionStartFunction
) {
  const [pendingId, setPendingId] = useState<string | null>(null);

  const toggle = (memberId: string, value: boolean) => {
    setPendingId(memberId);
    startTransition(async () => {
      applyOptimistic({ memberId, patch: patch(value) });
      try {
        const result = await action(memberId, value, projectId);
        if (result?.error) {
          toast.error(result.error);
          return;
        }
        toast.success(buildSuccessMessage(value, result.retried));
      } finally {
        setPendingId(null);
      }
    });
  };

  return { pendingId, toggle };
}

// Mensagem compartilhada por arbitrate/compare: "<verbo>." como base, com um
// sufixo sobre realocação quando o backend re-tentou alocar árbitro/revisor
// para casos que ficaram sem pool elegível (ver setCanArbitrate/setCanCompare).
export function buildRetriableToggleMessage(
  verb: string,
  poolNoun: string,
  retried?: RetryInfo
): string {
  if (retried && retried.assigned > 0 && retried.stillNoPool > 0) {
    return `${verb}. ${retried.assigned} caso(s) realocado(s); ${retried.stillNoPool} ainda sem ${poolNoun} elegível.`;
  }
  if (retried && retried.assigned > 0) {
    return `${verb}. ${retried.assigned} caso(s) realocado(s).`;
  }
  return `${verb}.`;
}
