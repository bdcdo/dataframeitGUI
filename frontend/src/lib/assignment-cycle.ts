// Ciclo manual da tabela de atribuições (`cycleAssignment`). Puro, fora do
// módulo "use server", que só pode exportar funções assíncronas.

interface CycleRow {
  id: string;
  status: string;
  type: string;
}

/**
 * O passo do ciclo vazio → codificacao → comparacao → vazio para as linhas do
 * par na rodada atual. Linha não pendente trava o par, com uma exceção:
 * codificação concluída sem comparação ainda pode ganhar a comparação da
 * própria codificação (`selfComparisonBesideDone`), que só se aplica se o
 * pesquisador de fato codificou o documento e o coordenador liberar.
 */
export type CycleStep =
  | { kind: "none" }
  | { kind: "insertCoding" }
  | { kind: "promote"; codingId: string }
  | { kind: "selfComparisonBesideDone" }
  | { kind: "delete"; ids: string[] };

export function planAssignmentCycle(rows: CycleRow[]): CycleStep {
  const coding = rows.find((r) => r.type === "codificacao");
  const comparison = rows.find((r) => r.type === "comparacao");
  if (rows.some((r) => r.status !== "pendente")) {
    return coding?.status === "concluido" && !comparison
      ? { kind: "selfComparisonBesideDone" }
      : { kind: "none" };
  }
  if (!coding && !comparison) return { kind: "insertCoding" };
  if (coding && !comparison) return { kind: "promote", codingId: coding.id };
  return { kind: "delete", ids: [coding?.id, comparison?.id].filter((id): id is string => Boolean(id)) };
}

type SelfComparisonDecision =
  | { outcome: "apply"; step: CycleStep }
  | { outcome: "confirm" }
  | { outcome: "rejected"; error: string };

export const SELF_COMPARISON_STALE_MESSAGE =
  "A atribuição mudou desde a confirmação. Confira a tabela e tente de novo.";
export const SELF_COMPARISON_NOT_CODER_MESSAGE =
  "Este pesquisador não tem codificação corrente neste documento.";

/**
 * Decide o passo diante da autoria do par. Dar comparação a quem codificou
 * (`coder`) exige a confirmação do coordenador (`allowed`). A confirmação vale
 * só para o passo que o coordenador viu: se, ao confirmar, o passo já não dá a
 * comparação a quem codificou (outra aba avançou o par, a codificação sumiu),
 * nada é gravado — em vez de aplicar em silêncio outra transição.
 */
export function decideSelfComparison(
  step: CycleStep,
  coder: boolean,
  allowed: boolean,
): SelfComparisonDecision {
  const givesComparison = step.kind === "promote" || step.kind === "selfComparisonBesideDone";
  const selfComparison = givesComparison && coder;
  if (allowed) {
    return selfComparison
      ? { outcome: "apply", step }
      : { outcome: "rejected", error: SELF_COMPARISON_STALE_MESSAGE };
  }
  if (selfComparison) return { outcome: "confirm" };
  if (step.kind === "selfComparisonBesideDone") {
    return { outcome: "rejected", error: SELF_COMPARISON_NOT_CODER_MESSAGE };
  }
  return { outcome: "apply", step };
}
