"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Keyboard } from "lucide-react";
import { cn } from "@/lib/utils";

const HINTS_DISMISSED_KEY = "autoReview:hintsDismissed";

// Rodapé do AutoReviewFieldPanel: botão de atalhos (com o painel de hints
// colapsável, persistido em localStorage) e o status/botão de envio.
export function AutoReviewFooter({
  readOnly,
  readyCount,
  incompleteCount,
  submitting,
  canSubmit,
  onSubmit,
}: {
  readOnly: boolean;
  readyCount: number;
  incompleteCount: number;
  submitting: boolean;
  canSubmit: boolean;
  onSubmit: () => void;
}) {
  // Hints começam abertos até o usuário fechar uma vez (persistido em localStorage).
  // Lazy initializer roda só uma vez no mount, lê do localStorage sem flicker.
  const [hintsOpen, setHintsOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(HINTS_DISMISSED_KEY) === null;
  });

  // O `setItem` fica no handler, não dentro do updater: React pode rodar o
  // updater mais de uma vez e o efeito colateral repetiria. Ler `hintsOpen` do
  // closure é seguro aqui porque só um clique alterna o valor — não há segunda
  // fonte de escrita que pudesse ser perdida no batching.
  function toggleHints() {
    const next = !hintsOpen;
    setHintsOpen(next);
    if (typeof window !== "undefined" && !next) {
      window.localStorage.setItem(HINTS_DISMISSED_KEY, "1");
    }
  }

  return (
    <div className="border-t px-4 py-2">
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1.5 px-2 text-xs text-muted-foreground"
          onClick={toggleHints}
        >
          <Keyboard className="size-3" />
          Atalhos
        </Button>
        {!readOnly ? (
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "text-xs",
                readyCount === 0 && incompleteCount > 0
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            >
              {readyCount > 0
                ? `${readyCount} campo${readyCount === 1 ? "" : "s"} pronto${readyCount === 1 ? "" : "s"} para enviar`
                : incompleteCount > 0
                  ? "Preencha a justificativa para enviar"
                  : "Decida um campo para enviar"}
            </span>
            <Button
              size="sm"
              onClick={onSubmit}
              disabled={!canSubmit}
              title={
                submitting
                  ? "Enviando…"
                  : readyCount > 0
                    ? "Enviar os campos decididos"
                    : "Decida ao menos um campo para enviar"
              }
            >
              {submitting ? "Enviando…" : "Enviar"}
            </Button>
          </div>
        ) : null}
      </div>
      {hintsOpen ? (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>
            <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
              1
            </kbd>{" "}
            Eu acertei
          </span>
          <span>
            <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
              2
            </kbd>{" "}
            LLM acertou
          </span>
          <span>
            <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
              3
            </kbd>{" "}
            Equivalentes
          </span>
          <span>
            <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
              4
            </kbd>{" "}
            Ambíguo
          </span>
          <span>
            <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
              P
            </kbd>{" "}
            Campo anterior
          </span>
          <span>
            <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
              N
            </kbd>{" "}
            Campo próximo
          </span>
        </div>
      ) : null}
    </div>
  );
}
