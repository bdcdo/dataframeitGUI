"use client";

import { useState, useRef, useEffect, useTransition } from "react";
import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { saveLlmConfig, savePrompt, toggleLlmField } from "@/actions/schema";
import { getEligibleDocCount } from "@/actions/llm";
import { fetchFastAPI } from "@/lib/api";
import { LLM_AMBIGUITIES_FIELD } from "@/lib/standard-questions";
import { toast } from "sonner";
import type { PydanticField } from "@/lib/types";

const MonacoEditor = dynamic(
  () => import("@monaco-editor/react").then((m) => m.default),
  { ssr: false }
);

type FilterMode = "all" | "pending" | "max_responses" | "random_sample";

interface LlmTabProps {
  projectId: string;
  promptTemplate: string;
  config: {
    llm_provider: string;
    llm_model: string;
    llm_kwargs: Record<string, any>;
  };
  pydanticFields: PydanticField[] | null;
  totalDocs: number;
  docsWithLlm: number;
}

export function LlmTab({
  projectId,
  promptTemplate: initialPrompt,
  config: initialConfig,
  pydanticFields,
  totalDocs,
  docsWithLlm,
}: LlmTabProps) {
  // Prompt state
  const [prompt, setPrompt] = useState(initialPrompt);
  const [savingPrompt, setSavingPrompt] = useState(false);

  // Config state
  const [config, setConfig] = useState(initialConfig);

  // Run state
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [sampleSize, setSampleSize] = useState(10);
  const [maxResponseCount, setMaxResponseCount] = useState(0);
  const [eligibleCount, setEligibleCount] = useState<number | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<string>("idle");
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [isPending, startTransition] = useTransition();

  const includeJustifications = !!(config.llm_kwargs.include_justifications);
  const hasAmbiguities =
    pydanticFields?.some((f) => f.name === "llm_ambiguidades") ?? false;

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  // Fetch eligible count when filter mode changes
  useEffect(() => {
    let cancelled = false;
    async function fetch() {
      const result = await getEligibleDocCount(
        projectId,
        filterMode,
        filterMode === "max_responses" ? maxResponseCount : undefined
      );
      if (!cancelled) setEligibleCount(result.eligible);
    }
    fetch();
    return () => { cancelled = true; };
  }, [projectId, filterMode, maxResponseCount]);

  // Computed eligible display
  const displayEligible = (() => {
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
    try {
      // Save config before running
      await saveLlmConfig(projectId, config);
      await savePrompt(projectId, prompt);

      const body: Record<string, unknown> = {
        project_id: projectId,
        filter_mode: filterMode,
      };
      if (filterMode === "random_sample") body.sample_size = sampleSize;
      if (filterMode === "max_responses")
        body.max_response_count = maxResponseCount;

      const res = await fetchFastAPI<{ job_id: string }>("/api/llm/run", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setJobId(res.job_id);
      setStatus("running");
      pollProgress(res.job_id);
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const pollProgress = (id: string) => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(async () => {
      try {
        const res = await fetchFastAPI<{
          status: string;
          progress: number;
          total: number;
          errors: string[];
        }>(`/api/llm/status/${id}`);
        setProgress(res.progress);
        setTotal(res.total);
        setStatus(res.status);
        if (res.status !== "running") {
          if (intervalRef.current) clearInterval(intervalRef.current);
          intervalRef.current = null;
          if (res.status === "completed") toast.success("LLM concluído!");
          if (res.status === "error")
            toast.error(res.errors[0] || "Erro na execução");
        }
      } catch {
        if (intervalRef.current) clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }, 2000);
  };

  const handleToggleJustifications = (checked: boolean) => {
    setConfig((c) => ({
      ...c,
      llm_kwargs: { ...c.llm_kwargs, include_justifications: checked },
    }));
  };

  const handleToggleAmbiguities = (checked: boolean) => {
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
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Prompt</h2>
          <Button
            size="sm"
            onClick={handleSavePrompt}
            disabled={savingPrompt}
            className="bg-brand hover:bg-brand/90 text-brand-foreground"
          >
            Salvar Prompt
          </Button>
        </div>
        <div className="h-80 rounded-md border overflow-hidden">
          <MonacoEditor
            height="100%"
            language="plaintext"
            theme="vs-light"
            value={prompt}
            onChange={(val) => setPrompt(val || "")}
            options={{
              minimap: { enabled: false },
              fontSize: 14,
              wordWrap: "on",
            }}
          />
        </div>
      </section>

      <Separator />

      {/* --- Configuração do Modelo --- */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Configuração do Modelo</h2>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label className="text-sm">Provider</Label>
            <Select
              value={config.llm_provider}
              onValueChange={(v) =>
                setConfig((c) => ({ ...c, llm_provider: v }))
              }
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
            <Input
              value={config.llm_model}
              onChange={(e) =>
                setConfig((c) => ({ ...c, llm_model: e.target.value }))
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm">Temperatura</Label>
            <Input
              type="number"
              step={0.1}
              min={0}
              max={2}
              value={config.llm_kwargs.temperature || 1.0}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  llm_kwargs: {
                    ...c.llm_kwargs,
                    temperature: parseFloat(e.target.value),
                  },
                }))
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm">Thinking Level</Label>
            <Select
              value={config.llm_kwargs.thinking_level || "medium"}
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
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
              </SelectContent>
            </Select>
          </div>
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
      </section>

      <Separator />

      {/* --- Execução --- */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Execução</h2>

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
            Salvar Config
          </Button>
          <Button
            onClick={handleRun}
            className="bg-brand hover:bg-brand/90 text-brand-foreground"
            disabled={status === "running" || displayEligible === 0}
          >
            Rodar LLM
          </Button>
        </div>

        {status === "running" && (
          <div className="space-y-2">
            <Progress value={total > 0 ? (progress / total) * 100 : 0} />
            <p className="text-sm text-muted-foreground">
              {progress}/{total}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
