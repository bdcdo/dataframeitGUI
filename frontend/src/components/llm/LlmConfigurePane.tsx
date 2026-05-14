"use client";

import { useState, useRef, useEffect, useTransition, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { saveLlmConfig, savePrompt, toggleLlmField } from "@/actions/schema";
import {
  cleanupStaleLlmRuns,
  getEligibleDocCount,
  getRunningLlmJob,
} from "@/actions/llm";
import { fetchFastAPI } from "@/lib/api";
import { LLM_AMBIGUITIES_FIELD } from "@/lib/standard-questions";
import {
  getModelsForProvider,
  getModelCapabilities,
  type Provider,
} from "@/lib/model-registry";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Check, ChevronsUpDown, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ModelCapabilities } from "@/lib/model-registry";
import type { PydanticField } from "@/lib/types";

import { Textarea } from "@/components/ui/textarea";

function buildKwargsForCapabilities(
  currentKwargs: Record<string, any>,
  caps: ModelCapabilities
): Record<string, any> {
  const newKwargs = { ...currentKwargs };
  if (!caps.supportsTemperature) delete newKwargs.temperature;
  else if (newKwargs.temperature == null) newKwargs.temperature = 1.0;
  if (!caps.supportsThinkingLevel) delete newKwargs.thinking_level;
  else if (!newKwargs.thinking_level) newKwargs.thinking_level = "medium";
  return newKwargs;
}
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronRight } from "lucide-react";
import { DocumentSelector } from "./DocumentSelector";
import { LlmErrorCard, type LlmErrorInfo } from "./LlmErrorCard";

function formatEta(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (mins < 60) return secs > 0 ? `${mins}min ${secs}s` : `${mins}min`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hours}h ${remainMins}min`;
}

type FilterMode = "all" | "pending" | "max_responses" | "random_sample" | "specific";

interface LlmConfigurePaneProps {
  projectId: string;
  promptTemplate: string;
  projectDescription: string;
  config: {
    llm_provider: string;
    llm_model: string;
    llm_kwargs: Record<string, any>;
  };
  pydanticFields: PydanticField[] | null;
  pydanticCode: string | null;
  totalDocs: number;
  docsWithLlm: number;
}

export function LlmConfigurePane({
  projectId,
  promptTemplate: initialPrompt,
  projectDescription,
  config: initialConfig,
  pydanticFields,
  pydanticCode,
  totalDocs,
  docsWithLlm,
}: LlmConfigurePaneProps) {
  const router = useRouter();

  // Prompt state
  const [prompt, setPrompt] = useState(initialPrompt);
  const [savingPrompt, setSavingPrompt] = useState(false);

  // Preview do prompt final — montado pelo backend (/api/llm/preview-prompt)
  // para não duplicar a lógica de _build_prompt no frontend.
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewPrompt, setPreviewPrompt] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Config state
  const [config, setConfig] = useState(initialConfig);

  // Run state
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [sampleSize, setSampleSize] = useState(10);
  const [maxResponseCount, setMaxResponseCount] = useState(0);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);
  const [eligibleCount, setEligibleCount] = useState<number | null>(null);
  const [, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<string>("idle");
  const [phase, setPhase] = useState<string>("idle");
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null);
  const [currentBatch, setCurrentBatch] = useState(0);
  const [totalBatches, setTotalBatches] = useState(0);
  const [processedComplete, setProcessedComplete] = useState(0);
  const [processedPartial, setProcessedPartial] = useState(0);
  const [processedEmpty, setProcessedEmpty] = useState(0);
  const [errorInfo, setErrorInfo] = useState<LlmErrorInfo | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [isPending, startTransition] = useTransition();

  const [modelOpen, setModelOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");

  // Model capabilities
  const capabilities = getModelCapabilities(
    config.llm_provider as Provider,
    config.llm_model
  );
  const providerModels = getModelsForProvider(config.llm_provider as Provider);
  const standardModels = providerModels.filter((m) => m.category === "standard");
  const reasoningModels = providerModels.filter((m) => m.category === "reasoning");

  const includeJustifications = !!(config.llm_kwargs.include_justifications);
  const [hasAmbiguities, setHasAmbiguities] = useState(
    pydanticFields?.some((f) => f.name === "llm_ambiguidades") ?? false
  );
  const [isStartingRun, setIsStartingRun] = useState(false);

  useEffect(() => {
    setHasAmbiguities(
      pydanticFields?.some((f) => f.name === "llm_ambiguidades") ?? false
    );
  }, [pydanticFields]);

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  // Busca o preview do prompt no backend enquanto o collapsible está aberto.
  // Debounce de 300ms porque `prompt` muda a cada tecla na textarea.
  useEffect(() => {
    if (!previewOpen) return;
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    const timer = setTimeout(async () => {
      try {
        const res = await fetchFastAPI<{ prompt: string }>(
          "/api/llm/preview-prompt",
          {
            method: "POST",
            body: JSON.stringify({
              project_description: projectDescription,
              prompt_template: prompt,
            }),
          }
        );
        if (!cancelled) setPreviewPrompt(res.prompt);
      } catch (e) {
        if (!cancelled)
          setPreviewError(
            e instanceof Error ? e.message : "Erro ao carregar preview"
          );
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [previewOpen, prompt, projectDescription]);

  // useCallback para referência estável — usado como dep do useEffect de
  // retomada de polling abaixo. Sem isso, o lint warning forçava um
  // eslint-disable e abria espaço para regressão se alguém adicionasse uma
  // dependência reativa dentro de pollProgress.
  const pollProgress = useCallback((id: string) => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(async () => {
      try {
        const res = await fetchFastAPI<{
          status: string;
          phase: string;
          progress: number;
          total: number;
          errors: string[];
          eta_seconds: number | null;
          current_batch: number;
          total_batches: number;
          error_traceback: string | null;
          error_type: string | null;
          error_line: number | null;
          error_column: number | null;
          pydantic_code: string | null;
          processed_complete: number;
          processed_partial: number;
          processed_empty: number;
        }>(`/api/llm/status/${id}`);
        setProgress(res.progress);
        setTotal(res.total);
        setStatus(res.status);
        setPhase(res.phase);
        setEtaSeconds(res.eta_seconds);
        setCurrentBatch(res.current_batch);
        setTotalBatches(res.total_batches);
        setProcessedComplete(res.processed_complete ?? 0);
        setProcessedPartial(res.processed_partial ?? 0);
        setProcessedEmpty(res.processed_empty ?? 0);
        if (res.status !== "running") {
          if (intervalRef.current) clearInterval(intervalRef.current);
          intervalRef.current = null;
          // Refresca o layout para o badge de execução desaparecer.
          router.refresh();
          if (res.status === "completed") toast.success("LLM concluído!");
          if (res.status === "error") {
            const msg = res.errors[0] || "Erro na execução";
            setErrorInfo({
              message: msg,
              type: res.error_type,
              traceback: res.error_traceback,
              line: res.error_line,
              column: res.error_column,
              // Prefer the snapshot stored with the run — the project's current
              // pydanticCode may have been edited between run start and failure.
              pydanticCode: res.pydantic_code ?? pydanticCode,
            });
            toast.error(msg, {
              duration: 10000,
              action: {
                label: "Ver detalhes",
                onClick: () =>
                  document
                    .getElementById("llm-error-card")
                    ?.scrollIntoView({ behavior: "smooth", block: "center" }),
              },
            });
          }
        }
      } catch (e: any) {
        if (intervalRef.current) clearInterval(intervalRef.current);
        intervalRef.current = null;
        setStatus("error");
        setPhase("error");
        const msg = e?.message ?? "Não foi possível atualizar o progresso";
        setErrorInfo({
          message: msg,
          type: "NetworkError",
          traceback: null,
          line: null,
          column: null,
          pydanticCode,
        });
        toast.error(msg);
      }
    }, 2000);
  }, [router, pydanticCode]);

  // Retomar polling se houver uma run em execucao ao montar (ex.: usuario
  // recarregou a pagina ou voltou para a aba). Sem isso, o card de execucao
  // some quando a aba fecha e o usuario nao tem feedback algum ate ir em
  // /llm/runs ou aguardar terminar.
  //
  // cleanupStaleLlmRuns roda primeiro para evitar religar polling em runs
  // cuja maquina morreu antes de completar (scale-to-zero do Fly.io). Tambem
  // resolve o sintoma cosmetico de runs eternamente "running" na aba
  // Execucoes.
  useEffect(() => {
    let cancelled = false;
    async function check() {
      await cleanupStaleLlmRuns(projectId);
      if (cancelled) return;
      const running = await getRunningLlmJob(projectId);
      if (cancelled || !running) return;
      // Reset counters antes de religar polling: sem isso, valores residuais
      // de uma run anterior (encerrada nesta sessao) ficariam visiveis ate o
      // primeiro tick do polling preencher os valores reais.
      setProcessedComplete(0);
      setProcessedPartial(0);
      setProcessedEmpty(0);
      setJobId(running.job_id);
      setStatus("running");
      setPhase("loading");
      pollProgress(running.job_id);
    }
    check();
    return () => {
      cancelled = true;
    };
  }, [projectId, pollProgress]);

  // Fetch eligible count when filter mode changes
  useEffect(() => {
    if (filterMode === "specific") return;
    let cancelled = false;
    async function fetch() {
      const result = await getEligibleDocCount(
        projectId,
        filterMode as "all" | "pending" | "max_responses" | "random_sample",
        filterMode === "max_responses" ? maxResponseCount : undefined
      );
      if (!cancelled) setEligibleCount(result.eligible);
    }
    fetch();
    return () => { cancelled = true; };
  }, [projectId, filterMode, maxResponseCount, status]);

  // Computed eligible display
  const displayEligible = (() => {
    if (filterMode === "specific") return selectedDocumentIds.length;
    if (filterMode === "random_sample") {
      return Math.min(sampleSize, eligibleCount ?? totalDocs);
    }
    return eligibleCount ?? totalDocs;
  })();

  // --- Handlers ---

  const handleSavePrompt = async () => {
    setSavingPrompt(true);
    try {
      await savePrompt(projectId, prompt);
      toast.success("Prompt salvo!");
    } catch (e: any) {
      toast.error(e.message);
    }
    setSavingPrompt(false);
  };

  const handleSaveConfig = async () => {
    try {
      await saveLlmConfig(projectId, config);
      toast.success("Configuração salva!");
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const handleRun = async () => {
    if (isStartingRun || status === "running") return;
    setIsStartingRun(true);
    setErrorInfo(null);
    try {
      // Save config before running
      await Promise.all([
        saveLlmConfig(projectId, config),
        savePrompt(projectId, prompt),
      ]);

      const body: Record<string, unknown> = {
        project_id: projectId,
        filter_mode: filterMode === "specific" ? "all" : filterMode,
      };
      if (filterMode === "specific") body.document_ids = selectedDocumentIds;
      if (filterMode === "random_sample") body.sample_size = sampleSize;
      if (filterMode === "max_responses")
        body.max_response_count = maxResponseCount;

      const res = await fetchFastAPI<{ job_id: string }>("/api/llm/run", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setJobId(res.job_id);
      setStatus("running");
      setPhase("loading");
      setEtaSeconds(null);
      setCurrentBatch(0);
      setTotalBatches(0);
      setProgress(0);
      setTotal(0);
      setProcessedComplete(0);
      setProcessedPartial(0);
      setProcessedEmpty(0);
      // Refresca o layout do projeto para o badge "LLM rodando" aparecer na aba.
      router.refresh();
      pollProgress(res.job_id);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setIsStartingRun(false);
    }
  };

  const handleToggleJustifications = (checked: boolean) => {
    setConfig((c) => ({
      ...c,
      llm_kwargs: { ...c.llm_kwargs, include_justifications: checked },
    }));
  };

  const handleToggleAmbiguities = (checked: boolean) => {
    setHasAmbiguities(checked);
    startTransition(async () => {
      try {
        await toggleLlmField(projectId, LLM_AMBIGUITIES_FIELD, checked);
        toast.success(
          checked
            ? "Campo de ambiguidades adicionado"
            : "Campo de ambiguidades removido"
        );
      } catch (e: any) {
        toast.error(e.message);
      }
    });
  };

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-6">
      {/* --- Prompt --- */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Prompt</CardTitle>
          <Button
            size="sm"
            onClick={handleSavePrompt}
            disabled={savingPrompt}
            className="bg-brand hover:bg-brand/90 text-brand-foreground"
          >
            Salvar
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            O prompt é montado automaticamente a partir da descrição do projeto e
            das instruções de cada campo (help text no schema). Use o campo abaixo
            para adicionar instruções complementares.
          </p>

          <Collapsible open={previewOpen} onOpenChange={setPreviewOpen}>
            <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors group">
              <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
              Ver preview do prompt final
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-2 rounded-md border bg-muted/50 p-4 text-sm whitespace-pre-wrap max-h-64 overflow-y-auto">
                {previewLoading && (
                  <p className="text-muted-foreground italic">
                    Carregando preview…
                  </p>
                )}
                {!previewLoading && previewError && (
                  <p className="text-destructive">{previewError}</p>
                )}
                {!previewLoading && !previewError && previewPrompt !== null && (
                  <>
                    {previewPrompt}
                    {!projectDescription.trim() && (
                      <p className="mt-2 text-muted-foreground italic">
                        (Sem descrição do projeto — configure em Config → Geral)
                      </p>
                    )}
                  </>
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>

          <div className="space-y-1.5">
            <Label className="text-sm">Instruções adicionais (opcional)</Label>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Adicione aqui instruções específicas que complementam o prompt automático..."
              className="min-h-[100px] resize-y text-sm"
            />
          </div>
        </CardContent>
      </Card>

      {/* --- Configuração do Modelo --- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Configuração do Modelo</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label className="text-sm">Provedor</Label>
            <Select
              value={config.llm_provider}
              onValueChange={(v) => {
                const models = getModelsForProvider(v as Provider);
                const firstModel = models[0]?.model ?? "";
                const caps = getModelCapabilities(v as Provider, firstModel);
                setConfig({ llm_provider: v, llm_model: firstModel, llm_kwargs: buildKwargsForCapabilities(config.llm_kwargs, caps) });
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="google_genai">Google GenAI</SelectItem>
                <SelectItem value="openai">OpenAI</SelectItem>
                <SelectItem value="anthropic">Anthropic</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm">Modelo</Label>
            <Popover open={modelOpen} onOpenChange={setModelOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={modelOpen}
                  className="w-full justify-between font-normal"
                >
                  {capabilities.label || config.llm_model || "Selecionar modelo..."}
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                <Command>
                  <CommandInput placeholder="Buscar modelo..." value={modelSearch} onValueChange={setModelSearch} />
                  <CommandList>
                    <CommandEmpty>
                      <button
                        className="w-full text-left px-2 py-1.5 text-sm hover:bg-accent rounded-sm"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          if (modelSearch) {
                            const caps = getModelCapabilities(config.llm_provider as Provider, modelSearch);
                            setConfig((c) => ({ ...c, llm_model: modelSearch, llm_kwargs: buildKwargsForCapabilities(c.llm_kwargs, caps) }));
                            setModelOpen(false);
                            setModelSearch("");
                          }
                        }}
                      >
                        Usar modelo personalizado
                      </button>
                    </CommandEmpty>
                    {reasoningModels.length > 0 && (
                      <CommandGroup heading="Raciocínio">
                        {reasoningModels.map((m) => (
                          <CommandItem
                            key={m.model}
                            value={m.model}
                            onSelect={(value) => {
                              const caps = getModelCapabilities(config.llm_provider as Provider, value);
                              setConfig((c) => ({ ...c, llm_model: value, llm_kwargs: buildKwargsForCapabilities(c.llm_kwargs, caps) }));
                              setModelOpen(false);
                            }}
                          >
                            <Check className={cn("mr-2 h-4 w-4", config.llm_model === m.model ? "opacity-100" : "opacity-0")} />
                            {m.label}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    )}
                    {standardModels.length > 0 && (
                      <CommandGroup heading="Padrão">
                        {standardModels.map((m) => (
                          <CommandItem
                            key={m.model}
                            value={m.model}
                            onSelect={(value) => {
                              const caps = getModelCapabilities(config.llm_provider as Provider, value);
                              setConfig((c) => ({ ...c, llm_model: value, llm_kwargs: buildKwargsForCapabilities(c.llm_kwargs, caps) }));
                              setModelOpen(false);
                            }}
                          >
                            <Check className={cn("mr-2 h-4 w-4", config.llm_model === m.model ? "opacity-100" : "opacity-0")} />
                            {m.label}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    )}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>
          {capabilities.supportsTemperature && (
            <div className="space-y-1.5">
              <Label className="text-sm">Temperatura</Label>
              <Input
                type="number"
                step={0.1}
                min={0}
                max={2}
                value={config.llm_kwargs.temperature ?? 1.0}
                onChange={(e) => {
                  const parsed = parseFloat(e.target.value);
                  if (!isNaN(parsed))
                    setConfig((c) => ({
                      ...c,
                      llm_kwargs: { ...c.llm_kwargs, temperature: parsed },
                    }));
                }}
              />
            </div>
          )}
          {capabilities.supportsThinkingLevel && (
            <div className="space-y-1.5">
              <Label className="text-sm">Nível de raciocínio</Label>
              <Select
                value={config.llm_kwargs.thinking_level ?? "medium"}
                onValueChange={(v) =>
                  setConfig((c) => ({
                    ...c,
                    llm_kwargs: { ...c.llm_kwargs, thinking_level: v },
                  }))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Baixo</SelectItem>
                  <SelectItem value="medium">Médio</SelectItem>
                  <SelectItem value="high">Alto</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {!capabilities.supportsTemperature && !capabilities.supportsThinkingLevel && (
            <div className="col-span-2 flex items-center gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              <Info className="h-4 w-4 shrink-0" />
              Este modelo não possui parâmetros configuráveis adicionais.
            </div>
          )}
        </div>

        {/* Behavior toggles */}
        <div className="space-y-3 pt-2">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-0.5">
              <Label className="text-sm">
                Pedir justificativas para cada resposta
              </Label>
              <p className="text-xs text-muted-foreground">
                O LLM explicará o raciocínio por trás de cada classificação.
              </p>
            </div>
            <Switch
              checked={includeJustifications}
              onCheckedChange={handleToggleJustifications}
            />
          </div>

          <div className="flex items-start justify-between gap-4">
            <div className="space-y-0.5">
              <Label className="text-sm">
                Registrar ambiguidades e dificuldades
              </Label>
              <p className="text-xs text-muted-foreground">
                O LLM reportará incertezas nas instruções e dificuldades na
                classificação. (campo llm_only)
              </p>
            </div>
            <Switch
              checked={hasAmbiguities}
              onCheckedChange={handleToggleAmbiguities}
              disabled={isPending}
            />
          </div>
        </div>

        {/* Advanced parameters */}
        <Collapsible>
          <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors group">
            <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
            Parâmetros avançados
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="grid grid-cols-2 gap-4 pt-3">
              <div className="space-y-1.5">
                <Label className="text-sm">Requisições paralelas</Label>
                <Input
                  type="number"
                  min={1}
                  max={50}
                  value={config.llm_kwargs.parallel_requests ?? 5}
                  onChange={(e) => {
                    const v = parseInt(e.target.value);
                    if (!isNaN(v) && v >= 1)
                      setConfig((c) => ({
                        ...c,
                        llm_kwargs: { ...c.llm_kwargs, parallel_requests: v },
                      }));
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Documentos processados simultaneamente.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm">Delay entre requisições (s)</Label>
                <Input
                  type="number"
                  step={0.1}
                  min={0}
                  max={10}
                  value={config.llm_kwargs.rate_limit_delay ?? 0.5}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    if (!isNaN(v) && v >= 0)
                      setConfig((c) => ({
                        ...c,
                        llm_kwargs: { ...c.llm_kwargs, rate_limit_delay: v },
                      }));
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Pausa entre requisições para evitar rate limits.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm">Cobertura mínima por documento (%)</Label>
                <Input
                  type="number"
                  step={1}
                  min={0}
                  max={100}
                  value={Math.round(
                    ((config.llm_kwargs.partial_coverage_threshold as number | undefined) ?? 0.5) * 100,
                  )}
                  onChange={(e) => {
                    const v = parseInt(e.target.value);
                    if (!isNaN(v) && v >= 0 && v <= 100)
                      setConfig((c) => ({
                        ...c,
                        llm_kwargs: {
                          ...c.llm_kwargs,
                          partial_coverage_threshold: v / 100,
                        },
                      }));
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Abaixo disso, a resposta entra como <code>is_current=false</code> e aparece marcada como parcial na aba Respostas.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm">Máx. % de docs parciais por rodada</Label>
                <Input
                  type="number"
                  step={1}
                  min={0}
                  max={100}
                  value={Math.round(
                    ((config.llm_kwargs.run_failure_threshold as number | undefined) ?? 0.3) * 100,
                  )}
                  onChange={(e) => {
                    const v = parseInt(e.target.value);
                    if (!isNaN(v) && v >= 0 && v <= 100)
                      setConfig((c) => ({
                        ...c,
                        llm_kwargs: {
                          ...c.llm_kwargs,
                          run_failure_threshold: v / 100,
                        },
                      }));
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Se essa fração dos documentos vier parcial, a rodada inteira é marcada como erro.
                </p>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
        </CardContent>
      </Card>

      {/* --- Execução --- */}
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
              <RadioGroupItem
                value="max_responses"
                id="filter-max-responses"
              />
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
                  onChange={(e) =>
                    setSampleSize(parseInt(e.target.value) || 1)
                  }
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
            onClick={handleSaveConfig}
            disabled={status === "running"}
          >
            Salvar configuração
          </Button>
          <Button
            onClick={handleRun}
            className="bg-brand hover:bg-brand/90 text-brand-foreground"
            disabled={isStartingRun || status === "running" || displayEligible === 0}
          >
            Rodar LLM
          </Button>
        </div>

        {status === "running" && (
          <div className="space-y-3 rounded-lg border p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Badge
                  variant={
                    phase === "processing" ? "default" :
                    phase === "saving" ? "outline" : "secondary"
                  }
                  className={phase === "processing" ? "bg-brand text-brand-foreground" : ""}
                >
                  {phase === "loading" && "Carregando"}
                  {phase === "processing" && "Processando"}
                  {phase === "saving" && "Salvando"}
                </Badge>
                {phase === "processing" && totalBatches > 0 && (
                  <span className="text-xs text-muted-foreground">
                    Lote {currentBatch}/{totalBatches}
                  </span>
                )}
              </div>
              {etaSeconds != null && etaSeconds > 0 && phase === "processing" && (
                <span className="text-xs text-muted-foreground">
                  ~{formatEta(etaSeconds)} restantes
                </span>
              )}
            </div>
            <Progress
              value={total > 0 ? (progress / total) * 100 : 0}
              className={phase === "loading" ? "animate-pulse" : ""}
            />
            <p className="text-sm text-muted-foreground">
              {phase === "loading" && "Carregando documentos..."}
              {phase === "processing" && `${progress}/${total} documentos processados`}
              {phase === "saving" && "Salvando resultados..."}
            </p>
            {/* Counters ao vivo: completas / parciais / vazias. Aparecem
                durante a fase de saving (quando o backend comeca a inserir
                em responses) e ate o fim da run para que o usuario tenha
                feedback imediato de como esta saindo.

                Granularidade DIFERE de `progress` (na Progress acima):
                  - progress = iter no result_df (incrementa antes do INSERT)
                  - processed_* = INSERT em responses concluido
                Durante a fase de saving as duas medidas podem divergir
                transitoriamente (ate ~2s, throttle do _persist_run_progress).
                Convergem ao final. Ver llm_runner.py:run_llm save loop. */}
            {(processedComplete > 0 || processedPartial > 0 || processedEmpty > 0) && (
              <div className="flex flex-wrap gap-2 pt-1">
                <Badge className="bg-emerald-600 hover:bg-emerald-600 text-white">
                  {processedComplete} completa{processedComplete !== 1 ? "s" : ""}
                </Badge>
                <Badge className="bg-amber-600 hover:bg-amber-600 text-white">
                  {processedPartial} parcia{processedPartial !== 1 ? "is" : "l"}
                </Badge>
                <Badge variant="destructive">
                  {processedEmpty} vazia{processedEmpty !== 1 ? "s" : ""}
                </Badge>
              </div>
            )}
          </div>
        )}

        {errorInfo && (
          <LlmErrorCard
            id="llm-error-card"
            error={errorInfo}
            onDismiss={() => setErrorInfo(null)}
          />
        )}
        </CardContent>
      </Card>
    </div>
  );
}
