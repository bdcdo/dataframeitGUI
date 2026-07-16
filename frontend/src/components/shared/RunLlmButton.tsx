"use client";

import { Button } from "@/components/ui/button";
import { Bot, Loader2 } from "lucide-react";
import { useLlmRun } from "./useLlmRun";

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
  /** Bloqueio contextual adicional para telas em modo somente leitura. Quando
   * `disabled`, `disabledReason` é o tooltip exibido (o botão não tem fallback
   * próprio — `RunLlmButton` vive em `shared/` e não conhece o texto da tela). */
  disabled?: boolean;
  disabledReason?: string;
  /** Repassa o modo somente-leitura da impersonação master ao backend, que é o
   * interlock de execução (issue #428). Default false: telas fora da Comparação
   * seguem executando. O botão já fica `disabled` no client; o sinal é o
   * backstop server-side caso a chamada chegue mesmo assim. */
  impersonating?: boolean;
}

const RUN_LLM_ACTIVE_LABEL = "Rodar LLM neste documento";

// Título/aria-label do botão, extraídos para manter o componente achatado. A
// variante `icon` não tem texto visível, então carrega o rótulo no aria-label;
// a de texto o dispensa. Sob `disabled` (somente leitura) o motivo
// (disabledReason) vira o tooltip e é anexado ao aria-label do ícone.
function runLlmLabels(
  disabled: boolean,
  disabledReason: string | undefined,
  isIcon: boolean,
): { title: string | undefined; ariaLabel: string | undefined } {
  if (disabled) {
    return {
      title: disabledReason,
      ariaLabel: isIcon
        ? `Rodar LLM indisponível${disabledReason ? `: ${disabledReason}` : ""}`
        : undefined,
    };
  }
  return {
    title: isIcon ? RUN_LLM_ACTIVE_LABEL : undefined,
    ariaLabel: isIcon ? RUN_LLM_ACTIVE_LABEL : undefined,
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
  const { running, run } = useLlmRun({
    projectId,
    documentId,
    impersonating,
    onComplete,
  });

  // Gate de coordenador: não renderiza para quem receberia 403 (#195).
  if (!canRunLlm) return null;

  const isIcon = size === "icon";
  const { title, ariaLabel } = runLlmLabels(disabled, disabledReason, isIcon);

  return (
    <Button
      variant={variant}
      size={size}
      className={isIcon ? "size-6" : "gap-1.5"}
      onClick={() => void run()}
      disabled={disabled || running}
      title={title}
      aria-label={ariaLabel}
    >
      <RunLlmStatusIcon running={running} />
      {!isIcon && "Rodar LLM"}
    </Button>
  );
}
