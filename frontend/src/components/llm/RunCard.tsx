"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { saveLlmConfig, savePrompt } from "@/actions/schema";
import { fetchFastAPI, requireSupabaseToken } from "@/lib/api";
import { useLlmRunProgress } from "@/hooks/useLlmRunProgress";
import { useEligibleDocCount } from "@/hooks/useEligibleDocCount";
import { LlmErrorCard } from "./LlmErrorCard";
import { RunProgress } from "./RunProgress";
import { RunFilterControls } from "./RunFilterControls";
import {
  MAX_RESPONSE_COUNT,
  MAX_SAMPLE_SIZE,
  getFilterValidationError,
  isIntegerInRange,
  type RunFilter,
} from "./run-filter";
import type { LlmConfig } from "@/lib/types";

interface RunCardProps {
  projectId: string;
  config: LlmConfig;
  prompt: string;
  pydanticCode: string | null;
  totalDocs: number;
  docsWithLlm: number;
}


export function RunCard({
  projectId,
  config,
  prompt,
  pydanticCode,
  totalDocs,
  docsWithLlm,
}: RunCardProps) {
  // Os quatro campos do filtro vivem num único objeto: descrevem uma seleção só
  // (modo + parâmetros do modo), e consolidá-los mantém o RunCard abaixo do
  // limiar de useState do `prefer-useReducer`.
  const [filter, setFilter] = useState<RunFilter>({
    mode: "all",
    sampleSize: 10,
    maxResponseCount: 0,
    selectedDocumentIds: [],
  });
  const [isStartingRun, setIsStartingRun] = useState(false);
  const { getToken } = useAuth();

  const { mode: filterMode, sampleSize, maxResponseCount, selectedDocumentIds } =
    filter;
  const updateFilter = (patch: Partial<RunFilter>) =>
    setFilter((current) => ({ ...current, ...patch }));
  const filterValidationError = getFilterValidationError(filter);
  const validMaxResponseCount = isIntegerInRange(
    maxResponseCount,
    0,
    MAX_RESPONSE_COUNT,
  )
    ? maxResponseCount
    : null;

  const {
    progress,
    total,
    status,
    phase,
    etaSeconds,
    currentBatch,
    totalBatches,
    processedComplete,
    processedPartial,
    processedEmpty,
    errorInfo,
    start,
    dismissError,
  } = useLlmRunProgress(projectId, pydanticCode);

  const { eligibleCount } = useEligibleDocCount(
    projectId,
    filterMode,
    validMaxResponseCount,
    status,
  );

  const displayEligible = (() => {
    if (filterMode === "specific") return selectedDocumentIds.length;
    if (filterMode === "random_sample") {
      return sampleSize === null
        ? 0
        : Math.min(sampleSize, eligibleCount ?? totalDocs);
    }
    return eligibleCount ?? totalDocs;
  })();

  const handleSaveConfig = async () => {
    try {
      const r = await saveLlmConfig(projectId, config);
      if (r?.error) toast.error(r.error);
      else toast.success("Configuração salva!");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Erro ao salvar configuração");
    }
  };

  const handleRun = async () => {
    if (isStartingRun || status === "running") return;
    if (filterValidationError) {
      toast.error(filterValidationError);
      return;
    }
    setIsStartingRun(true);
    try {
      // Save config before running.
      const [cfgResult, promptResult] = await Promise.all([
        saveLlmConfig(projectId, config),
        savePrompt(projectId, prompt),
      ]);
      const saveError = cfgResult?.error ?? promptResult?.error;
      if (saveError) {
        toast.error(saveError);
        return;
      }

      const body: Record<string, unknown> = {
        project_id: projectId,
        filter_mode: filterMode === "specific" ? "all" : filterMode,
      };
      if (filterMode === "specific") body.document_ids = selectedDocumentIds;
      if (
        filterMode === "random_sample" &&
        isIntegerInRange(sampleSize, 1, MAX_SAMPLE_SIZE)
      ) {
        body.sample_size = sampleSize;
      }
      if (filterMode === "max_responses" && validMaxResponseCount !== null) {
        body.max_response_count = validMaxResponseCount;
      }

      const token = await requireSupabaseToken(getToken);
      const res = await fetchFastAPI<{ job_id: string }>(
        "/api/llm/run",
        {
          method: "POST",
          body: JSON.stringify(body),
        },
        token,
      );
      start(res.job_id);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Erro ao iniciar execução");
    } finally {
      setIsStartingRun(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Execução</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <RunFilterControls
          projectId={projectId}
          filter={filter}
          validationError={filterValidationError}
          onChange={updateFilter}
        />

        {filterValidationError === null && (
          <p className="text-sm text-muted-foreground">
            {displayEligible} documento{displayEligible !== 1 ? "s" : ""}{" "}
            {displayEligible !== 1 ? "serão" : "será"} processado
            {displayEligible !== 1 ? "s" : ""}
            <span className="ml-1 text-xs">
              ({docsWithLlm}/{totalDocs} já possuem resposta LLM)
            </span>
          </p>
        )}

        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => void handleSaveConfig()}
            disabled={status === "running"}
          >
            Salvar configuração
          </Button>
          <Button
            onClick={() => void handleRun()}
            className="bg-brand hover:bg-brand/90 text-brand-foreground"
            disabled={
              isStartingRun ||
              status === "running" ||
              displayEligible === 0 ||
              filterValidationError !== null
            }
          >
            Rodar LLM
          </Button>
        </div>

        {status === "running" && (
          <RunProgress
            phase={phase}
            progress={progress}
            total={total}
            etaSeconds={etaSeconds}
            currentBatch={currentBatch}
            totalBatches={totalBatches}
            processedComplete={processedComplete}
            processedPartial={processedPartial}
            processedEmpty={processedEmpty}
          />
        )}

        {errorInfo && (
          <LlmErrorCard
            id="llm-error-card"
            error={errorInfo}
            onDismiss={dismissError}
          />
        )}
      </CardContent>
    </Card>
  );
}
