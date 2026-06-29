"use client";

import { useEffect, useState } from "react";
import { getLotteryDocStats } from "@/actions/assignments";
import type { LotteryStats } from "./lottery-dialog-types";

export interface LotteryStatsState {
  stats: LotteryStats | null;
  statsError: boolean;
}

/**
 * Stats de elegibilidade do sorteio, recarregadas a cada abertura do dialog —
 * um sorteio muda atribuições/lotes, então reabrir com stats da abertura
 * anterior mentiria na contagem de elegíveis. Extraído de `LotteryDialog`.
 */
export function useLotteryStats(
  projectId: string,
  open: boolean,
): LotteryStatsState {
  const [stats, setStats] = useState<LotteryStats | null>(null);
  const [statsError, setStatsError] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getLotteryDocStats(projectId)
      .then((s) => {
        if (!cancelled) {
          setStats(s);
          setStatsError(false);
        }
      })
      .catch(() => {
        if (!cancelled) setStatsError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  return { stats, statsError };
}
