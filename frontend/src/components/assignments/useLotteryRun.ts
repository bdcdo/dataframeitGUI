import { useMemo, useState } from "react";
import { smartRandomize, previewLottery } from "@/actions/assignments";
import type { LotteryParams } from "@/actions/assignments";
import {
  filterComparisonEligible,
  filterEligibleDocs,
  resolveWeight,
  resolveCap,
  type LotteryFilters,
} from "@/lib/lottery-utils";
import { toast } from "sonner";
import type { LotteryMember, LotteryStats } from "./lottery-dialog-types";
import type { LotteryParamsState } from "./useLotteryParams";
import {
  capValue,
  isParticipant,
  weightValue,
} from "./lottery-participant-values";

// Derivações e ações do sorteio (elegibilidade, prévia, submit) sobre o
// estado do formulário (useLotteryParams). Lê os campos de `params`
// desestruturados — nunca o objeto inteiro em deps de memo, que é recriado
// a cada render do dialog.
export function useLotteryRun({
  projectId,
  members,
  stats,
  params,
  onLotteryDone,
}: {
  projectId: string;
  members: LotteryMember[];
  stats: LotteryStats | null;
  params: LotteryParamsState;
  // Chamado no sucesso do sorteio (fecha o dialog); a limpeza da prévia é
  // feita aqui dentro.
  onLotteryDone: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  const {
    type,
    researchersPerDoc,
    docsPerResearcherEnabled,
    docsPerResearcher,
    docSubsetEnabled,
    docSubsetSize,
    balancing,
    mode,
    codingsFilterMode,
    maxCodingsValue,
    assignmentFilter,
    batchFilterMode,
    batchExclude,
    batchOnly,
    manualEnabled,
    manualDocIds,
    participantOverrides,
    weightInputs,
    capInputs,
    label,
    previewState,
    setPreviewState,
  } = params;

  const participantIds = useMemo(
    () =>
      members
        .filter((m) => isParticipant(m, participantOverrides))
        .map((m) => m.userId),
    [members, participantOverrides],
  );

  // Peso/limite resolvido por participante ativo. Inclui TODOS os participantes
  // (peso 1 / sem limite explícito) para que o server persista o reset de quem
  // voltou ao default — não só quem está fora do padrão.
  const participantSettings = useMemo(() => {
    const out: Record<string, { weight: number; cap: number | null }> = {};
    for (const m of members) {
      if (!isParticipant(m, participantOverrides)) continue;
      const cStr = capValue(m, capInputs);
      out[m.userId] = {
        // Mesma coerção do server (resolveWeight/resolveCap) — fonte única.
        weight: resolveWeight(parseFloat(weightValue(m, weightInputs))),
        cap: resolveCap(cStr.trim() === "" ? null : parseInt(cStr, 10)),
      };
    }
    return out;
  }, [members, participantOverrides, weightInputs, capInputs]);

  const isComparacao = type === "comparacao";

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

  // Prévia + semente (research D13): a seed da última prévia é reaproveitada
  // ao sortear; a prévia é guardada junto da configuração que a gerou, então
  // qualquer mudança de configuração a invalida (e à seed) por derivação.
  // O rótulo fica de fora: não afeta o resultado do sorteio, e é lido em
  // buildParams na hora do submit
  const configKey = JSON.stringify({
    type,
    researchersPerDoc,
    docsPerResearcherEnabled,
    docsPerResearcher,
    docSubsetEnabled,
    docSubsetSize,
    mode,
    balancing,
    filters,
    participantIds,
    participantSettings,
  });
  const preview = previewState?.key === configKey ? previewState.preview : null;
  const seed = preview?.seed ?? null;

  // Contagem de elegíveis ao vivo, com a mesma função pura do server
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

  const blockedMessage =
    participantIds.length === 0
      ? "Nenhum participante selecionado."
      : eligibleCount === 0
        ? "Nenhum documento passa nos filtros atuais."
        : null;

  const canSubmit = !blockedMessage && stats !== null;

  const buildParams = (withSeed: boolean): LotteryParams => ({
    projectId,
    type,
    mode,
    balancing,
    seed: withSeed && seed !== null ? seed : undefined,
    researchersPerDoc,
    docsPerResearcher: docsPerResearcherEnabled
      ? docsPerResearcher
      : undefined,
    docSubsetSize: docSubsetEnabled ? docSubsetSize : undefined,
    label: label || undefined,
    filters,
    participantIds,
    participantSettings,
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
        `${result.count} novas atribuições criadas! (${result.preserved} preservadas)`
      );
      setPreviewState(null);
      onLotteryDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao sortear");
    }
    setLoading(false);
  };

  const docsConsidered =
    eligibleCount === null
      ? null
      : docSubsetEnabled
        ? Math.min(docSubsetSize, eligibleCount)
        : eligibleCount;

  const estimatedPerParticipant =
    docsConsidered !== null && participantIds.length > 0
      ? Math.ceil((docsConsidered * researchersPerDoc) / participantIds.length)
      : 0;

  return {
    isComparacao,
    participantCount: participantIds.length,
    eligibleCount,
    blockedMessage,
    canSubmit,
    preview,
    estimatedPerParticipant,
    previewing,
    loading,
    handlePreview,
    handleRandomize,
  };
}
