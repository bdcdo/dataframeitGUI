"use client";

import { useState, useRef, useEffect, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Progress } from "@/components/ui/progress";
import { saveLlmConfig, toggleLlmField } from "@/actions/schema";
import { fetchFastAPI } from "@/lib/api";
import { LLM_AMBIGUITIES_FIELD } from "@/lib/standard-questions";
import { toast } from "sonner";
import type { PydanticField } from "@/lib/types";

interface LlmControlProps {
  projectId: string;
  config: {
    llm_provider: string;
    llm_model: string;
    llm_kwargs: Record<string, any>;
  };
  pydanticFields: PydanticField[] | null;
}

export function LlmControl({ projectId, config: initialConfig, pydanticFields }: LlmControlProps) {
  const [config, setConfig] = useState(initialConfig);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<string>("idle");
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [isPending, startTransition] = useTransition();

  const includeJustifications = !!(config.llm_kwargs.include_justifications);
  const hasAmbiguities = pydanticFields?.some((f) => f.name === "llm_ambiguidades") ?? false;

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const handleSave = async () => {
    try {
      await saveLlmConfig(projectId, config);
      toast.success("Configuração salva!");
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const handleRun = async (mode: "all" | "pending") => {
    try {
      const res = await fetchFastAPI<{ job_id: string }>("/api/llm/run", {
        method: "POST",
        body: JSON.stringify({ project_id: projectId }),
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
        const res = await fetchFastAPI<{ status: string; progress: number; total: number; errors: string[] }>(`/api/llm/status/${id}`);
        setProgress(res.progress);
        setTotal(res.total);
        setStatus(res.status);
        if (res.status !== "running") {
          if (intervalRef.current) clearInterval(intervalRef.current);
          intervalRef.current = null;
          if (res.status === "completed") toast.success("LLM concluído!");
          if (res.status === "error") toast.error(res.errors[0] || "Erro na execução");
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
        toast.success(checked ? "Campo de ambiguidades adicionado" : "Campo de ambiguidades removido");
      } catch (e: any) {
        toast.error(e.message);
      }
    });
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-sm font-medium">Provider</label>
          <select
            value={config.llm_provider}
            onChange={(e) => setConfig((c) => ({ ...c, llm_provider: e.target.value }))}
            className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
          >
            <option value="google_genai">Google GenAI</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </div>
        <div>
          <label className="text-sm font-medium">Modelo</label>
          <Input
            value={config.llm_model}
            onChange={(e) => setConfig((c) => ({ ...c, llm_model: e.target.value }))}
          />
        </div>
        <div>
          <label className="text-sm font-medium">Temperature</label>
          <Input
            type="number"
            step={0.1}
            min={0}
            max={2}
            value={config.llm_kwargs.temperature || 1.0}
            onChange={(e) => setConfig((c) => ({ ...c, llm_kwargs: { ...c.llm_kwargs, temperature: parseFloat(e.target.value) } }))}
          />
        </div>
        <div>
          <label className="text-sm font-medium">Thinking Level</label>
          <select
            value={config.llm_kwargs.thinking_level || "medium"}
            onChange={(e) => setConfig((c) => ({ ...c, llm_kwargs: { ...c.llm_kwargs, thinking_level: e.target.value } }))}
            className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>
      </div>

      {/* Comportamento do LLM */}
      <div className="space-y-4">
        <Separator />
        <Label className="text-sm font-medium">Comportamento do LLM</Label>

        <div className="flex items-start justify-between gap-4">
          <div className="space-y-0.5">
            <Label className="text-sm">Pedir justificativas para cada resposta</Label>
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
            <Label className="text-sm">Registrar ambiguidades e dificuldades</Label>
            <p className="text-xs text-muted-foreground">
              O LLM reportará incertezas nas instruções e dificuldades na classificação. (campo llm_only)
            </p>
          </div>
          <Switch
            checked={hasAmbiguities}
            onCheckedChange={handleToggleAmbiguities}
            disabled={isPending}
          />
        </div>
      </div>

      <Separator />

      <div className="flex gap-2">
        <Button variant="outline" onClick={handleSave}>Salvar Config</Button>
        <Button onClick={() => handleRun("all")} className="bg-brand hover:bg-brand/90 text-brand-foreground" disabled={status === "running"}>
          Rodar em todos
        </Button>
        <Button variant="outline" onClick={() => handleRun("pending")} disabled={status === "running"}>
          Rodar pendentes
        </Button>
      </div>

      {status === "running" && (
        <div className="space-y-2">
          <Progress value={total > 0 ? (progress / total) * 100 : 0} />
          <p className="text-sm text-muted-foreground">{progress}/{total}</p>
        </div>
      )}
    </div>
  );
}
