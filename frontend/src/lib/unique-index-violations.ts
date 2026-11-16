/**
 * Primitiva das invariantes que espelham um índice UNIQUE
 * (scripts/invariants/check-invariants.ts): agrupa as linhas pela chave do
 * índice e devolve cada chave com mais de uma linha.
 *
 * Segue a semântica padrão do Postgres (NULLS DISTINCT): linha com NULL em
 * alguma coluna da chave não colide com nada e fica de fora, como no índice.
 * Contá-la como duplicata seria acusar violação que o banco permite.
 *
 * Quem chama decide a chave exata do índice, e o predicado parcial dele
 * (`WHERE ...`) filtra as linhas antes de chegarem aqui.
 */

import { groupBy } from "@/lib/utils";

export interface Violation {
  key: string;
  detail: string;
}

export function uniqueIndexViolations<T extends { id: string }>(
  rows: readonly T[],
  keyColumns: (row: T) => readonly (string | null)[],
  /** Rótulo do detalhe: "2 <noun>: id-1, id-2". */
  noun: string,
): Violation[] {
  const keyed = rows.flatMap((row) => {
    const columns = keyColumns(row);
    return columns.includes(null) ? [] : [{ key: columns.join("|"), id: row.id }];
  });
  return [...groupBy(keyed, (r) => r.key)]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => ({
      key,
      detail: `${group.length} ${noun}: ${group.map((r) => r.id).join(", ")}`,
    }));
}
