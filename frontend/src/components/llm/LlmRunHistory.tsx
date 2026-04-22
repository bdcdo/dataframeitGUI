"use client";

import { formatModelLabel } from "@/lib/model-registry";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import {
  ChevronRight,
  History,
  CheckCircle2,
  XCircle,
  Loader2,
} from "lucide-react";
import type { LlmRunRecord } from "@/actions/llm";
import type { LlmErrorInfo } from "./LlmErrorCard";

interface LlmRunHistoryProps {
  runs: LlmRunRecord[];
  pydanticCode: string | null;
  onOpenError: (err: LlmErrorInfo) => void;
}

function formatModelOrDash(provider: string | null, model: string | null): string {
  if (!provider || !model) return "—";
  return formatModelLabel(`${provider}/${model}`);
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function StatusIcon({ status }: { status: LlmRunRecord["status"] }) {
  if (status === "completed")
    return (
      <CheckCircle2
        className="h-4 w-4 text-emerald-600"
        aria-label="Concluído"
      />
    );
  if (status === "error")
    return <XCircle className="h-4 w-4 text-destructive" aria-label="Erro" />;
  return (
    <Loader2
      className="h-4 w-4 animate-spin text-muted-foreground"
      aria-label="Em execução"
    />
  );
}

export function LlmRunHistory({
  runs,
  pydanticCode,
  onOpenError,
}: LlmRunHistoryProps) {
  if (runs.length === 0) return null;

  const errorCount = runs.filter((r) => r.status === "error").length;

  return (
    <Collapsible defaultOpen={errorCount > 0}>
      <CollapsibleTrigger className="group flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-90" />
        <History className="h-3.5 w-3.5" />
        Histórico de execuções ({runs.length})
        {errorCount > 0 && (
          <Badge variant="destructive" className="ml-1 h-5 px-1.5 text-[10px]">
            {errorCount} erro{errorCount > 1 ? "s" : ""}
          </Badge>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="w-8 px-2 py-2 font-medium" />
                <th className="px-3 py-2 font-medium">Modelo</th>
                <th className="px-3 py-2 font-medium">Filtro</th>
                <th className="px-3 py-2 font-medium text-right">Docs</th>
                <th className="px-3 py-2 font-medium text-right">Data</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const isError = run.status === "error";
                const rowClasses = [
                  "border-b last:border-0",
                  isError
                    ? "cursor-pointer hover:bg-destructive/5"
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                const handleClick = isError
                  ? () =>
                      onOpenError({
                        message: run.error_message ?? "Erro sem mensagem",
                        type: run.error_type,
                        traceback: run.error_traceback,
                        line: run.error_line,
                        column: run.error_column,
                        pydanticCode: run.pydantic_code ?? pydanticCode,
                      })
                  : undefined;
                return (
                  <tr
                    key={run.id}
                    className={rowClasses}
                    onClick={handleClick}
                    title={isError ? "Clique para ver detalhes do erro" : undefined}
                  >
                    <td className="px-2 py-2">
                      <StatusIcon status={run.status} />
                    </td>
                    <td className="px-3 py-2">
                      {formatModelOrDash(run.llm_provider, run.llm_model)}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {run.filter_mode ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right text-muted-foreground">
                      {run.document_count ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right text-muted-foreground">
                      {formatDateTime(run.started_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
