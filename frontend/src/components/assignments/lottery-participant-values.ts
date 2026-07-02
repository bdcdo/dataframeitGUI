// Leitura dos inputs por participante do sorteio — funções puras usadas
// tanto pela seção Participantes (exibição) quanto pelo useLotteryRun
// (participantSettings): fonte única para a coerção, sem drift.

import type { LotteryMember } from "./lottery-dialog-types";

export function isParticipant(
  m: LotteryMember,
  overrides: Record<string, boolean>,
): boolean {
  return overrides[m.userId] ?? m.role === "pesquisador";
}

// String exibida nos inputs: override local, senão default persistido.
export function weightValue(
  m: LotteryMember,
  weightInputs: Record<string, string>,
): string {
  return weightInputs[m.userId] ?? String(m.weight ?? 1);
}

export function capValue(
  m: LotteryMember,
  capInputs: Record<string, string>,
): string {
  return capInputs[m.userId] ?? (m.cap != null ? String(m.cap) : "");
}
