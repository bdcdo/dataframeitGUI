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
  /** Bloqueio contextual adicional para telas em modo somente leitura. */
  disabled?: boolean;
  disabledReason?: string;
  /** Repassa o modo somente-leitura da impersonação master ao backend, que é o
   * interlock de execução (issue #428). Default false: telas fora da Comparação
   * seguem executando. O botão já fica `disabled` no client; o sinal é o
   * backstop server-side caso a chamada chegue mesmo assim. */
  impersonating?: boolean;
}

interface RunLlmControlState {
  disabled: boolean;
  iconTitle: string;
  textTitle: string | undefined;
  iconAriaLabel: string;
}

function getRunLlmControlState(
  disabled: boolean,
  disabledReason: string | undefined,
  running: boolean,
): RunLlmControlState {
  if (disabled) {
    const reason = disabledReason ?? "Indisponível no modo somente leitura";
    return {
      disabled: true,
      iconTitle: reason,
      textTitle: reason,
      iconAriaLabel: `Rodar LLM indisponível: ${reason}`,
    };
  }
  return {
    disabled: running,
    iconTitle: "Rodar LLM neste documento",
    textTitle: undefined,
    iconAriaLabel: "Rodar LLM neste documento",
  };
}

function RunLlmStatusIcon({ running }: { running: boolean }) {
  if (running) return <Loader2 className="size-3.5 animate-spin" />;
  return <Bot className="size-3.5" />;
}

export function RunLlmButton({
  projectId,
  documentId,
  onComplete,
  size = "icon",
  variant = "ghost",
  canRunLlm = true,
  disabled = false,
  disabledReason,
  impersonating = false,
}: RunLlmButtonProps) {
  const { getToken } = useAuth();
  const [running, setRunning] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);
  const failuresRef = useRef(0);
  const controlState = getRunLlmControlState(
    disabled,
    disabledReason,
    running,
  );

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
            timeoutRef.current = setTimeout(() => void poll(), 2000);
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
            timeoutRef.current = setTimeout(() => void poll(), 2000);
          }
        }
      };

      timeoutRef.current = setTimeout(() => void poll(), 2000);
    },
    [onComplete, getToken]
  );

  const handleRun = async () => {
    if (controlState.disabled) return;
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
            impersonating,
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
        onClick={() => void handleRun()}
        disabled={controlState.disabled}
        title={controlState.iconTitle}
        aria-label={controlState.iconAriaLabel}
      >
        <RunLlmStatusIcon running={running} />
      </Button>
    );
  }

  return (
    <Button
      variant={variant}
      size={size}
      onClick={() => void handleRun()}
      disabled={controlState.disabled}
      title={controlState.textTitle}
      className="gap-1.5"
    >
      <RunLlmStatusIcon running={running} />
      Rodar LLM
    </Button>
  );
}
