"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { fetchFastAPI } from "@/lib/api";
import { toast } from "sonner";
import { Bot, Loader2 } from "lucide-react";

interface RunLlmButtonProps {
  projectId: string;
  documentId: string;
  onComplete?: () => void;
  size?: "icon" | "sm" | "default";
  variant?: "ghost" | "outline" | "default";
}

export function RunLlmButton({
  projectId,
  documentId,
  onComplete,
  size = "icon",
  variant = "ghost",
}: RunLlmButtonProps) {
  const [running, setRunning] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);

  const cleanup = useCallback(() => {
    cancelledRef.current = true;
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const pollStatus = useCallback(
    (jobId: string) => {
      cancelledRef.current = false;

      const poll = async () => {
        if (cancelledRef.current) return;
        try {
          const status = await fetchFastAPI<{
            status: string;
            errors: string[];
          }>(`/api/llm/status/${jobId}`);

          if (cancelledRef.current) return;

          if (status.status !== "running") {
            setRunning(false);
            if (status.status === "completed") {
              toast.success("LLM concluído para este documento!");
              onComplete?.();
            } else {
              toast.error(status.errors[0] || "Erro na execução");
            }
          } else {
            timeoutRef.current = setTimeout(poll, 2000);
          }
        } catch {
          if (cancelledRef.current) return;
          setRunning(false);
          toast.error("Erro ao verificar progresso");
        }
      };

      timeoutRef.current = setTimeout(poll, 2000);
    },
    [onComplete]
  );

  const handleRun = async () => {
    if (running) return;
    setRunning(true);

    try {
      const res = await fetchFastAPI<{ job_id: string }>("/api/llm/run", {
        method: "POST",
        body: JSON.stringify({
          project_id: projectId,
          document_ids: [documentId],
          filter_mode: "all",
        }),
      });

      pollStatus(res.job_id);
    } catch (e: any) {
      setRunning(false);
      toast.error(e.message);
    }
  };

  if (size === "icon") {
    return (
      <Button
        variant={variant}
        size="icon"
        className="h-6 w-6"
        onClick={handleRun}
        disabled={running}
        title="Rodar LLM neste documento"
      >
        {running ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Bot className="h-3.5 w-3.5" />
        )}
      </Button>
    );
  }

  return (
    <Button
      variant={variant}
      size={size}
      onClick={handleRun}
      disabled={running}
      className="gap-1.5"
    >
      {running ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Bot className="h-3.5 w-3.5" />
      )}
      Rodar LLM
    </Button>
  );
}
