"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { useAuth } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";
import { fetchFastAPI, requireSupabaseToken } from "@/lib/api";
import { toast } from "sonner";
import { Bot, Loader2 } from "lucide-react";

// Tolera N falhas consecutivas de poll (token transitório, blip de rede) antes
// de declarar a execução terminal: o job segue rodando no backend e um erro
// isolado não deve derrubar o acompanhamento e mostrar erro falso.
const MAX_POLL_FAILURES = 3;

interface RunLlmButtonProps {
  projectId: string;
  documentId: string;
  onComplete?: () => void;
  size?: "icon" | "sm" | "default";
  variant?: "ghost" | "outline" | "default";
  /** Rodar LLM exige coordenador do projeto no backend (#195). Quando false, o
   * botão nem é renderizado — evita mostrar a um pesquisador uma ação que
   * sempre retornaria 403. Default true para não exigir o prop de callers que
   * já só renderizam em contexto de coordenador. */
  canRunLlm?: boolean;
}

export function RunLlmButton({
  projectId,
  documentId,
  onComplete,
  size = "icon",
  variant = "ghost",
  canRunLlm = true,
}: RunLlmButtonProps) {
  const { getToken } = useAuth();
  const [running, setRunning] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);
  const failuresRef = useRef(0);

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
      failuresRef.current = 0;

      const poll = async () => {
        if (cancelledRef.current) return;
        try {
          // Token fresco a cada poll: o do template expira em ~60s e o
          // polling pode durar minutos. O await roda antes do guard de
          // cancelamento de propósito (mesma razão da supressão no fetchFastAPI
          // abaixo): o token precisa estar fresco quando a request de status
          // parte, e mover o await para baixo do guard atrasaria a renovação.
          // react-doctor-disable-next-line react-doctor/async-defer-await
          const token = await requireSupabaseToken(getToken);
          // O guard de cancelamento abaixo roda DEPOIS do await de propósito: o
          // usuário pode cancelar enquanto a request de status está em voo, então
          // re-checamos `cancelledRef` após a rede retornar. Mover o await para
          // baixo do guard anularia essa semântica de cancelamento.
          // react-doctor-disable-next-line react-doctor/async-defer-await
          const status = await fetchFastAPI<{
            status: string;
            errors: string[];
          }>(`/api/llm/status/${jobId}`, undefined, token);

          if (cancelledRef.current) return;
          failuresRef.current = 0;

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
          // Falha isolada não é terminal: o job segue no backend. Só desiste
          // após MAX_POLL_FAILURES consecutivas (token transitório/blip de rede).
          failuresRef.current += 1;
          if (failuresRef.current >= MAX_POLL_FAILURES) {
            setRunning(false);
            toast.error("Erro ao verificar progresso");
          } else {
            timeoutRef.current = setTimeout(poll, 2000);
          }
        }
      };

      timeoutRef.current = setTimeout(poll, 2000);
    },
    [onComplete, getToken]
  );

  const handleRun = async () => {
    if (running) return;
    setRunning(true);

    try {
      const token = await requireSupabaseToken(getToken);
      const res = await fetchFastAPI<{ job_id: string }>(
        "/api/llm/run",
        {
          method: "POST",
          body: JSON.stringify({
            project_id: projectId,
            document_ids: [documentId],
            filter_mode: "all",
          }),
        },
        token
      );

      pollStatus(res.job_id);
    } catch (e: unknown) {
      setRunning(false);
      toast.error(e instanceof Error ? e.message : "Erro ao iniciar execução");
    }
  };

  // Gate de coordenador: não renderiza para quem receberia 403 (#195).
  if (!canRunLlm) return null;

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
