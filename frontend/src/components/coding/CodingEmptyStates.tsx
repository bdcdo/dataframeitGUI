"use client";

import { Button } from "@/components/ui/button";
import { CheckCircle2, FileQuestion, ClipboardList } from "lucide-react";
import { CURRENT_FILTER_VALUE } from "@/lib/rounds";
import type { RoundFilterData } from "./CodingPage";

type CodingEmptyStatesProps =
  | { kind: "no-fields" }
  | { kind: "all-done"; count: number; onExploreMore: () => void }
  | { kind: "no-doc"; hasAssignments: boolean; roundFilter?: RoundFilterData };

/** Estados vazios do CodingPage (schema ausente, tudo codificado, sem doc). */
export function CodingEmptyStates(props: CodingEmptyStatesProps) {
  if (props.kind === "no-fields") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <FileQuestion className="size-10 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">
          Schema não definido. Configure os campos em Configurações → Schema.
        </p>
      </div>
    );
  }

  if (props.kind === "all-done") {
    const { count, onExploreMore } = props;
    const plural = count !== 1 ? "s" : "";
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <CheckCircle2 className="size-16 text-brand" />
        <h2 className="text-xl font-semibold">Parabéns!</h2>
        <p className="text-muted-foreground">
          Você completou todos os {count} documento{plural} atribuído{plural}.
        </p>
        <div className="flex gap-3 mt-2">
          <Button
            className="bg-brand hover:bg-brand/90 text-brand-foreground"
            onClick={onExploreMore}
          >
            Explorar mais documentos
          </Button>
        </div>
      </div>
    );
  }

  const { hasAssignments, roundFilter } = props;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <ClipboardList className="size-10 text-muted-foreground/50" />
      {hasAssignments && roundFilter ? (
        roundFilter.selected === "all" ? (
          <p className="text-sm text-muted-foreground">
            Nenhum documento corresponde ao filtro.
          </p>
        ) : roundFilter.selected === "" ||
          roundFilter.selected === CURRENT_FILTER_VALUE ? (
          <p className="text-sm text-muted-foreground">
            Tudo em dia na rodada atual ({roundFilter.currentRoundLabel}).
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Nenhuma resposta sua nessa rodada.
          </p>
        )
      ) : (
        <p className="text-sm text-muted-foreground">
          Nenhum documento atribuído. Use a aba Explorar.
        </p>
      )}
    </div>
  );
}
