// Ciclo manual da tabela de atribuições (`cycleAssignment`). Puro, fora do
// módulo "use server", que só pode exportar funções assíncronas.

export interface CycleRow {
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

