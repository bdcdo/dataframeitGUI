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
          // O guard de cancelamento abaixo roda DEPOIS do await de propósito: o
          // usuário pode cancelar enquanto a request de status está em voo, então
          // re-checamos `cancelledRef` após a rede retornar. Mover o await para
          // baixo do guard anularia essa semântica de cancelamento.
          // react-doctor-disable-next-line react-doctor/async-defer-await
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
    } catch (e: unknown) {
      setRunning(false);
      toast.error(e instanceof Error ? e.message : "Erro ao iniciar execução");
    }
  };

  if (size === "icon") {
    return (
      <Button
        variant={variant}
        size="icon"
        className="size-6"
        onClick={handleRun}
        disabled={running}
        title="Rodar LLM neste documento"
      >
        {running ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Bot className="size-3.5" />
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
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <Bot className="size-3.5" />
      )}
      Rodar LLM
    </Button>
  );
}
