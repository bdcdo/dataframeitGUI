"use client";

import {
  useCallback,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { resolveCap, resolveWeight } from "@/lib/lottery-utils";
import type { LotteryMember } from "./lottery-dialog-types";

export interface LotteryParticipants {
  isParticipant: (m: LotteryMember) => boolean;
  /** String exibida no input de peso: override local, senão default do membro. */
  weightValue: (m: LotteryMember) => string;
  /** String exibida no input de limite: override local, senão default do membro. */
  capValue: (m: LotteryMember) => string;
  participantIds: string[];
  participantSettings: Record<string, { weight: number; cap: number | null }>;
  memberName: (userId: string) => string;
  setParticipantOverrides: Dispatch<SetStateAction<Record<string, boolean>>>;
  setWeightInputs: Dispatch<SetStateAction<Record<string, string>>>;
  setCapInputs: Dispatch<SetStateAction<Record<string, string>>>;
}

/**
 * Seleção de participantes (default por role + overrides), pesos/limites por
 * participante e as derivações `participantIds`/`participantSettings`. Derivar
 * do prop `members` em vez de snapshot garante que membro adicionado com o
 * dialog montado entra com o default do role. Extraído de `LotteryDialog`.
 */
export function useLotteryParticipants(
  members: LotteryMember[],
): LotteryParticipants {
  // Default por role (pesquisador ON, coordenador OFF) + overrides dos toggles.
  const [participantOverrides, setParticipantOverrides] = useState<
    Record<string, boolean>
  >({});
  // Peso/limite por participante, editados como string (inputs controlados).
  // Ausência da chave = usar o default persistido do membro (m.weight/m.cap).
  const [weightInputs, setWeightInputs] = useState<Record<string, string>>({});
  const [capInputs, setCapInputs] = useState<Record<string, string>>({});

  const isParticipant = useCallback(
    (m: LotteryMember) =>
      participantOverrides[m.userId] ?? m.role === "pesquisador",
    [participantOverrides],
  );

  const weightValue = useCallback(
    (m: LotteryMember) => weightInputs[m.userId] ?? String(m.weight ?? 1),
    [weightInputs],
  );
  const capValue = useCallback(
    (m: LotteryMember) =>
      capInputs[m.userId] ?? (m.cap != null ? String(m.cap) : ""),
    [capInputs],
  );

  const participantIds = useMemo(
    () =>
      members
        .filter(
          (m) => participantOverrides[m.userId] ?? m.role === "pesquisador",
        )
        .map((m) => m.userId),
    [members, participantOverrides],
  );

  // Peso/limite resolvido por participante ativo. Inclui TODOS os participantes
  // (peso 1 / sem limite explícito) para que o server persista o reset de quem
  // voltou ao default — não só quem está fora do padrão.
  const participantSettings = useMemo(() => {
    const out: Record<string, { weight: number; cap: number | null }> = {};
    for (const m of members) {
      if (!(participantOverrides[m.userId] ?? m.role === "pesquisador"))
        continue;
      const cStr = capValue(m);
      out[m.userId] = {
        // Mesma coerção do server (resolveWeight/resolveCap) — fonte única.
        weight: resolveWeight(parseFloat(weightValue(m))),
        cap: resolveCap(cStr.trim() === "" ? null : parseInt(cStr, 10)),
      };
    }
    return out;
  }, [members, participantOverrides, weightValue, capValue]);

  const memberName = useCallback(
    (userId: string) =>
      members.find((m) => m.userId === userId)?.name ?? userId.slice(0, 8),
    [members],
  );

  return {
    isParticipant,
    weightValue,
    capValue,
    participantIds,
    participantSettings,
    memberName,
    setParticipantOverrides,
    setWeightInputs,
    setCapInputs,
  };
}
