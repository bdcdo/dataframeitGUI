import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface ArbitrationPageHeaderProps {
  phase: "blind" | "reveal";
  docIndex: number;
  docsLength: number;
  submitting: boolean;
  allBlindChosen: boolean;
  allFinalChosen: boolean;
  onNavigate: (index: number) => void;
  onBackToBlind: () => void;
  onBlindSubmit: () => void;
  onFinalSubmit: () => void;
}

export function ArbitrationPageHeader({
  phase,
  docIndex,
  docsLength,
  submitting,
  allBlindChosen,
  allFinalChosen,
  onNavigate,
  onBackToBlind,
  onBlindSubmit,
  onFinalSubmit,
}: ArbitrationPageHeaderProps) {
  return (
    <div className="flex h-10 shrink-0 items-center justify-between border-b px-4 text-sm">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-medium">Arbitragem humano vs LLM</span>
        <Badge variant={phase === "blind" ? "default" : "secondary"}>
          {phase === "blind" ? "Cega" : "Revelação"}
        </Badge>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge variant="secondary" className="text-xs">
          {docsLength} doc{docsLength === 1 ? "" : "s"}
        </Badge>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={() => onNavigate(docIndex - 1)}
            disabled={docIndex === 0}
            title="Documento anterior"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span className="text-xs text-muted-foreground">
            {docIndex + 1}/{docsLength}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={() => onNavigate(docIndex + 1)}
            disabled={docIndex === docsLength - 1}
            title="Próximo documento"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
        {phase === "reveal" ? (
          <Button
            variant="outline"
            size="sm"
            onClick={onBackToBlind}
            title="Voltar à fase cega (sua decisão fica registrada)"
          >
            Voltar à cega
          </Button>
        ) : null}
        {phase === "blind" ? (
          <Button
            size="sm"
            onClick={onBlindSubmit}
            disabled={!allBlindChosen || submitting}
          >
            {submitting ? "Salvando…" : "Avançar para revelação"}
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={onFinalSubmit}
            disabled={!allFinalChosen || submitting}
          >
            {submitting ? "Enviando…" : "Enviar arbitragem"}
          </Button>
        )}
      </div>
    </div>
  );
}
