"use client";

import { useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Keyboard } from "lucide-react";
import { cn } from "@/lib/utils";

const HINTS_DISMISSED_KEY = "autoReview:hintsDismissed";

const SHORTCUT_HINTS = [
  ["1", "Eu acertei"],
  ["2", "LLM acertou"],
  ["3", "Equivalentes"],
  ["4", "Ambíguo"],
  ["P", "Campo anterior"],
  ["N", "Campo próximo"],
] as const;

// A dispensa só muda pelo clique deste componente, que já guarda o estado
// local; não há escritor externo a ouvir.
const subscribeNothing = () => () => {};
const readHintsDismissed = () =>
  window.localStorage.getItem(HINTS_DISMISSED_KEY) !== null;
// O servidor não tem localStorage: renderiza fechado, e a hidratação usa o
// mesmo valor antes de ler o storage.
const serverHintsDismissed = () => true;

function submitStatus(readyCount: number, incompleteCount: number): string {
  if (readyCount > 0) {
    const plural = readyCount === 1 ? "" : "s";
    return `${readyCount} campo${plural} pronto${plural} para enviar`;
  }
  return incompleteCount > 0
    ? "Preencha a justificativa para enviar"
    : "Decida um campo para enviar";
}

function submitTitle(submitting: boolean, readyCount: number): string {
  if (submitting) return "Enviando…";
  return readyCount > 0
    ? "Enviar os campos decididos"
    : "Decida ao menos um campo para enviar";
}

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
  // Hints começam abertos até o usuário fechar uma vez (persistido em
  // localStorage). Depois do primeiro clique vale o estado local.
  const hintsDismissed = useSyncExternalStore(
    subscribeNothing,
    readHintsDismissed,
    serverHintsDismissed,
  );
  const [toggledOpen, setToggledOpen] = useState<boolean | null>(null);
  const hintsOpen = toggledOpen ?? !hintsDismissed;

  // O `setItem` fica no handler, não dentro do updater: React pode rodar o
  // updater mais de uma vez e o efeito colateral repetiria. Ler `hintsOpen` do
  // closure é seguro aqui porque só um clique alterna o valor — não há segunda
  // fonte de escrita que pudesse ser perdida no batching.
  function toggleHints() {
    const next = !hintsOpen;
    setToggledOpen(next);
    if (!next) window.localStorage.setItem(HINTS_DISMISSED_KEY, "1");
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
              {submitStatus(readyCount, incompleteCount)}
            </span>
            <Button
              size="sm"
              onClick={onSubmit}
              disabled={!canSubmit}
              title={submitTitle(submitting, readyCount)}
            >
              {submitting ? "Enviando…" : "Enviar"}
            </Button>
          </div>
        ) : null}
      </div>
      {hintsOpen ? (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {SHORTCUT_HINTS.map(([key, label]) => (
            <span key={key}>
              <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                {key}
              </kbd>{" "}
              {label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
