"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { toast } from "sonner";
import { saveLlmConfig, savePrompt } from "@/actions/schema";
import { fetchFastAPI, requireSupabaseToken } from "@/lib/api";
import { useLlmRunProgress } from "@/hooks/useLlmRunProgress";
import { useEligibleDocCount } from "@/hooks/useEligibleDocCount";
import { DocumentSelector } from "./DocumentSelector";
import { LlmErrorCard } from "./LlmErrorCard";
import { RunProgress } from "./RunProgress";
import type { LlmConfig } from "@/lib/types";

type FilterMode =
  | "all"
  | "pending"
  | "max_responses"
  | "random_sample"
  | "specific";

interface RunCardProps {
  projectId: string;
  config: LlmConfig;
  prompt: string;
  pydanticCode: string | null;
  totalDocs: number;
  docsWithLlm: number;
}

interface RunFilter {
  mode: FilterMode;
  sampleSize: number;
  maxResponseCount: number;
  selectedDocumentIds: string[];
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
  const setFilterMode = (mode: FilterMode) =>
    setFilter((f) => ({ ...f, mode }));
  const setSampleSize = (value: number) =>
    setFilter((f) => ({ ...f, sampleSize: value }));
  const setMaxResponseCount = (value: number) =>
    setFilter((f) => ({ ...f, maxResponseCount: value }));
  const setSelectedDocumentIds = (ids: string[]) =>
    setFilter((f) => ({ ...f, selectedDocumentIds: ids }));

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
    maxResponseCount,
    status,
  );

  const displayEligible = (() => {
    if (filterMode === "specific") return selectedDocumentIds.length;
    if (filterMode === "random_sample") {
      return Math.min(sampleSize, eligibleCount ?? totalDocs);
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
      if (filterMode === "random_sample") body.sample_size = sampleSize;
      if (filterMode === "max_responses")
        body.max_response_count = maxResponseCount;

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
        <RadioGroup
          value={filterMode}
          onValueChange={(v) => setFilterMode(v as FilterMode)}
          className="gap-3"
        >
          <div className="flex items-center gap-2">
            <RadioGroupItem value="all" id="filter-all" />
            <Label htmlFor="filter-all" className="text-sm font-normal">
              Todos os documentos
            </Label>
          </div>

          <div className="flex items-center gap-2">
            <RadioGroupItem value="pending" id="filter-pending" />
            <Label htmlFor="filter-pending" className="text-sm font-normal">
              Apenas pendentes (sem resposta LLM)
            </Label>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <RadioGroupItem value="max_responses" id="filter-max-responses" />
              <Label
                htmlFor="filter-max-responses"
                className="text-sm font-normal"
              >
                Documentos com até N respostas LLM
              </Label>
            </div>
            {filterMode === "max_responses" && (
              <div className="ml-6">
                <Input
                  type="number"
                  min={0}
                  value={maxResponseCount}
                  onChange={(e) =>
                    setMaxResponseCount(parseInt(e.target.value) || 0)
                  }
                  className="w-24"
                />
              </div>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <RadioGroupItem value="random_sample" id="filter-random" />
              <Label htmlFor="filter-random" className="text-sm font-normal">
                Amostra aleatória
              </Label>
            </div>
            {filterMode === "random_sample" && (
              <div className="ml-6 flex items-center gap-2">
                <Label className="text-sm text-muted-foreground">
                  Quantidade:
                </Label>
                <Input
                  type="number"
                  min={1}
                  value={sampleSize}
                  onChange={(e) => setSampleSize(parseInt(e.target.value) || 1)}
                  className="w-24"
                />
              </div>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <RadioGroupItem value="specific" id="filter-specific" />
              <Label htmlFor="filter-specific" className="text-sm font-normal">
                Documentos específicos
              </Label>
            </div>
            {filterMode === "specific" && (
              <div className="ml-6">
                <DocumentSelector
                  projectId={projectId}
                  selectedIds={selectedDocumentIds}
                  onSelectionChange={setSelectedDocumentIds}
                />
              </div>
            )}
          </div>
        </RadioGroup>

        <p className="text-sm text-muted-foreground">
          {displayEligible} documento{displayEligible !== 1 ? "s" : ""}{" "}
          {displayEligible !== 1 ? "serão" : "será"} processado
          {displayEligible !== 1 ? "s" : ""}
          <span className="ml-1 text-xs">
            ({docsWithLlm}/{totalDocs} já possuem resposta LLM)
          </span>
        </p>

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
              isStartingRun || status === "running" || displayEligible === 0
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
