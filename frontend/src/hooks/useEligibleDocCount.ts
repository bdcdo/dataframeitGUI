"use client";

import { useEffect, useState } from "react";
import { getEligibleDocCount } from "@/actions/llm";

export type EligibleFilterMode =
  | "all"
  | "pending"
  | "max_responses"
  | "random_sample";

/**
 * Conta os documentos elegíveis para o modo de filtro atual via server action
 * `getEligibleDocCount`. O modo `specific` não consulta o backend (a contagem
 * vem da seleção local), então o effect faz early-return nesse caso.
 *
 * Segue o molde de `useDocumentText`: a action é chamada em `.then` (não num
 * `async function fetch()` interno), o que mantém o effect livre do
 * `no-fetch-in-effect`. Best-effort: se a contagem falhar, mantém o valor
 * anterior (o display cai no fallback `totalDocs`) sem unhandled rejection.
 *
 * `status` entra nas deps para recomputar quando uma run termina.
 */
export function useEligibleDocCount(
  projectId: string,
  filterMode: EligibleFilterMode | "specific",
  maxResponseCount: number | null,
  status: string,
): { eligibleCount: number | null } {
  const [eligibleCount, setEligibleCount] = useState<number | null>(null);

  useEffect(() => {
    if (
      filterMode === "specific" ||
      (filterMode === "max_responses" && maxResponseCount === null)
    ) {
      return;
    }
    let cancelled = false;
    getEligibleDocCount(
      projectId,
      filterMode,
      filterMode === "max_responses"
        ? (maxResponseCount ?? undefined)
        : undefined,
    )
      .then((result) => {
        if (!cancelled) setEligibleCount(result.eligible);
      })
      .catch((e) => {
        console.error("Falha ao calcular documentos elegíveis:", e);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, filterMode, maxResponseCount, status]);

  return { eligibleCount };
}
