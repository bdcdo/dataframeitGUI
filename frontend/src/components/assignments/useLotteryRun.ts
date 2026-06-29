"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import { toast } from "sonner";
import {
  previewLottery,
  smartRandomize,
  type LotteryParams,
  type LotteryPreview,
} from "@/actions/assignments";
import type { LotteryDistribution } from "./useLotteryDistribution";
import type { LotteryFiltersState } from "./useLotteryFilters";
import type { LotteryParticipants } from "./useLotteryParticipants";
import type { LotteryStats } from "./lottery-dialog-types";

interface UseLotteryRunParams {
  projectId: string;
  dist: LotteryDistribution;
  filtersState: LotteryFiltersState;
  participants: LotteryParticipants;
  stats: LotteryStats | null;
  /** Chamado após um sorteio bem-sucedido (o componente fecha o dialog). */
  onRandomized: () => void;
}

export interface LotteryRun {
  label: string;
  setLabel: Dispatch<SetStateAction<string>>;
  previewing: boolean;
  loading: boolean;
  /** Prévia válida para a configuração atual, ou null se invalidada. */
  preview: LotteryPreview | null;
  blockedMessage: string | null;
  canSubmit: boolean;
  docsConsidered: number | null;
  estimatedPerParticipant: number;
  handlePreview: () => Promise<void>;
  handleRandomize: () => Promise<void>;
  /** Limpa a prévia guardada (usado ao fechar o dialog). */
  clearPreview: () => void;
}

/**
 * Orquestração de prévia/sorteio: rótulo, estados de carga, a prévia guardada
 * (research D13: a seed da última prévia é reaproveitada ao sortear; a prévia
 * fica atrelada à configuração que a gerou, então qualquer mudança a invalida
 * por derivação via `configKey`), `buildParams` e os derivados de submissão.
 * Extraído de `LotteryDialog`.
 */
export function useLotteryRun({
  projectId,
  dist,
  filtersState,
  participants,
  stats,
  onRandomized,
}: UseLotteryRunParams): LotteryRun {
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [label, setLabel] = useState("");
  const [previewState, setPreviewState] = useState<{
    key: string;
    preview: LotteryPreview;
  } | null>(null);

  // O rótulo fica de fora da chave: não afeta o resultado do sorteio, e é lido
  // em buildParams na hora do submit.
  const configKey = JSON.stringify({
    type: dist.type,
    researchersPerDoc: dist.researchersPerDoc,
    docsPerResearcherEnabled: dist.docsPerResearcherEnabled,
    docsPerResearcher: dist.docsPerResearcher,
    docSubsetEnabled: dist.docSubsetEnabled,
    docSubsetSize: dist.docSubsetSize,
    mode: dist.mode,
    balancing: dist.balancing,
    filters: filtersState.filters,
    participantIds: participants.participantIds,
    participantSettings: participants.participantSettings,
  });
  const preview =
    previewState?.key === configKey ? previewState.preview : null;
  const seed = preview?.seed ?? null;

  const blockedMessage =
    participants.participantIds.length === 0
      ? "Nenhum participante selecionado."
      : filtersState.eligibleCount === 0
        ? "Nenhum documento passa nos filtros atuais."
        : null;

  const canSubmit = !blockedMessage && stats !== null;

  const buildParams = (withSeed: boolean): LotteryParams => ({
    projectId,
    type: dist.type,
    mode: dist.mode,
    balancing: dist.balancing,
    seed: withSeed && seed !== null ? seed : undefined,
    researchersPerDoc: dist.researchersPerDoc,
    docsPerResearcher: dist.docsPerResearcherEnabled
      ? dist.docsPerResearcher
      : undefined,
    docSubsetSize: dist.docSubsetEnabled ? dist.docSubsetSize : undefined,
    label: label || undefined,
    filters: filtersState.filters,
    participantIds: participants.participantIds,
    participantSettings: participants.participantSettings,
  });

  const handlePreview = async () => {
    setPreviewing(true);
    try {
      const result = await previewLottery(buildParams(false));
      setPreviewState({ key: configKey, preview: result });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao calcular a prévia");
    }
    setPreviewing(false);
  };

  const handleRandomize = async () => {
    setLoading(true);
    try {
      const result = await smartRandomize(buildParams(true));
      toast.success(
        `${result.count} novas atribuições criadas! (${result.preserved} preservadas)`,
      );
      onRandomized();
      setPreviewState(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao sortear");
    }
    setLoading(false);
  };

  const docsConsidered =
    filtersState.eligibleCount === null
      ? null
      : dist.docSubsetEnabled
        ? Math.min(dist.docSubsetSize, filtersState.eligibleCount)
        : filtersState.eligibleCount;

  const estimatedPerParticipant =
    docsConsidered !== null && participants.participantIds.length > 0
      ? Math.ceil(
          (docsConsidered * dist.researchersPerDoc) /
            participants.participantIds.length,
        )
      : 0;

  return {
    label,
    setLabel,
    previewing,
    loading,
    preview,
    blockedMessage,
    canSubmit,
    docsConsidered,
    estimatedPerParticipant,
    handlePreview,
    handleRandomize,
    clearPreview: () => setPreviewState(null),
  };
}
