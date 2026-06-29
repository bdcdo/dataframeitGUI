"use client";

import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import {
  filterComparisonEligible,
  filterEligibleDocs,
  type AssignmentFilter,
  type LotteryFilters,
} from "@/lib/lottery-utils";
import type { CodingsFilterMode, LotteryStats } from "./lottery-dialog-types";

interface UseLotteryFiltersParams {
  stats: LotteryStats | null;
  type: "codificacao" | "comparacao";
  isComparacao: boolean;
}

export interface LotteryFiltersState {
  codingsFilterMode: CodingsFilterMode;
  setCodingsFilterMode: Dispatch<SetStateAction<CodingsFilterMode>>;
  maxCodingsValue: number;
  setMaxCodingsValue: Dispatch<SetStateAction<number>>;
  assignmentFilter: AssignmentFilter;
  setAssignmentFilter: Dispatch<SetStateAction<AssignmentFilter>>;
  batchFilterMode: "none" | "exclude" | "only";
  setBatchFilterMode: Dispatch<SetStateAction<"none" | "exclude" | "only">>;
  batchExclude: string[];
  setBatchExclude: Dispatch<SetStateAction<string[]>>;
  batchOnly: string | null;
  setBatchOnly: Dispatch<SetStateAction<string | null>>;
  manualEnabled: boolean;
  setManualEnabled: Dispatch<SetStateAction<boolean>>;
  manualDocIds: Set<string>;
  setManualDocIds: Dispatch<SetStateAction<Set<string>>>;
  /** Filtros normalizados para o server/funções puras de elegibilidade. */
  filters: LotteryFilters;
  /** Contagem de elegíveis ao vivo, com a mesma função pura do server. */
  eligibleCount: number | null;
}

/**
 * Filtros de elegibilidade (codificações humanas, status de atribuição, lotes,
 * seleção manual) + o objeto `filters` derivado e a contagem de elegíveis ao
 * vivo. Extraído de `LotteryDialog`.
 */
export function useLotteryFilters({
  stats,
  type,
  isComparacao,
}: UseLotteryFiltersParams): LotteryFiltersState {
  const [codingsFilterMode, setCodingsFilterMode] =
    useState<CodingsFilterMode>("all");
  const [maxCodingsValue, setMaxCodingsValue] = useState(1);
  const [assignmentFilter, setAssignmentFilter] =
    useState<AssignmentFilter>("any");
  const [batchFilterMode, setBatchFilterMode] = useState<
    "none" | "exclude" | "only"
  >("none");
  const [batchExclude, setBatchExclude] = useState<string[]>([]);
  const [batchOnly, setBatchOnly] = useState<string | null>(null);
  const [manualEnabled, setManualEnabled] = useState(false);
  const [manualDocIds, setManualDocIds] = useState<Set<string>>(new Set());

  const filters = useMemo<LotteryFilters>(() => {
    const f: LotteryFilters = {};
    if (codingsFilterMode === "none") f.maxHumanCodings = 0;
    else if (codingsFilterMode === "atMost") f.maxHumanCodings = maxCodingsValue;
    if (assignmentFilter !== "any") f.assignmentFilter = assignmentFilter;
    if (batchFilterMode === "only" && batchOnly) {
      f.batchFilter = { only: batchOnly };
    } else if (batchFilterMode === "exclude" && batchExclude.length) {
      f.batchFilter = { exclude: batchExclude };
    }
    if (manualEnabled) f.manualDocIds = Array.from(manualDocIds);
    return f;
  }, [
    codingsFilterMode,
    maxCodingsValue,
    assignmentFilter,
    batchFilterMode,
    batchOnly,
    batchExclude,
    manualEnabled,
    manualDocIds,
  ]);

  const eligibleCount = useMemo(() => {
    if (!stats) return null;
    let candidates = stats.docs;
    if (isComparacao) {
      candidates = filterComparisonEligible(
        candidates,
        stats.automationMode,
        stats.minResponsesForComparison,
      );
    }
    return filterEligibleDocs(candidates, type, filters).length;
  }, [stats, type, isComparacao, filters]);

  return {
    codingsFilterMode,
    setCodingsFilterMode,
    maxCodingsValue,
    setMaxCodingsValue,
    assignmentFilter,
    setAssignmentFilter,
    batchFilterMode,
    setBatchFilterMode,
    batchExclude,
    setBatchExclude,
    batchOnly,
    setBatchOnly,
    manualEnabled,
    setManualEnabled,
    manualDocIds,
    setManualDocIds,
    filters,
    eligibleCount,
  };
}
