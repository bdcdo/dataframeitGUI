"use client";

import { useState } from "react";
import Link from "next/link";
import { formatModelLabel } from "@/lib/model-registry";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import {
  ChevronRight,
  CheckCircle2,
  XCircle,
  Loader2,
  FileText,
} from "lucide-react";
import type { LlmRunRecord } from "@/actions/llm";
import { LlmErrorCard, type LlmErrorInfo } from "./LlmErrorCard";

export interface LlmRunStats {
  current: number;
  partial: number;
}

interface LlmRunsPaneProps {
  projectId: string;
  runs: LlmRunRecord[];
  stats: Record<string, LlmRunStats>;
}

const FILTER_LABELS: Record<string, string> = {
  all: "Todos",
  pending: "Pendentes",
  max_responses: "Até N respostas",
  random_sample: "Amostra aleatória",
};

function formatFilterMode(mode: string | null): string {
  if (!mode) return "—";
  return FILTER_LABELS[mode] ?? mode;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(start: string, end: string | null): string {
  if (!end) return "—";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return "<1s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs > 0 ? `${m}min ${rs}s` : `${m}min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}min`;
}

function StatusBadge({ status }: { status: LlmRunRecord["status"] }) {
  if (status === "completed")
    return (
      <Badge className="bg-emerald-600 hover:bg-emerald-600 text-white gap-1">
        <CheckCircle2 className="h-3 w-3" /> Concluído
      </Badge>
    );
  if (status === "error")
    return (
      <Badge variant="destructive" className="gap-1">
        <XCircle className="h-3 w-3" /> Erro
      </Badge>
    );
  return (
    <Badge variant="secondary" className="gap-1">
      <Loader2 className="h-3 w-3 animate-spin" /> Em execução
    </Badge>
  );
}

export function LlmRunsPane({ projectId, runs, stats }: LlmRunsPaneProps) {
  const [openErrorId, setOpenErrorId] = useState<string | null>(null);

  if (runs.length === 0) {
    return (
      <div className="mx-auto max-w-4xl p-6 text-sm text-muted-foreground">
        Nenhuma execução registrada ainda. Vá em{" "}
        <Link
          href={`/projects/${projectId}/llm/configure`}
          className="underline hover:text-foreground"
        >
          Configurar
        </Link>{" "}
        para rodar o LLM.
      </div>
    );
  }

  const errorInfoForRun = (run: LlmRunRecord): LlmErrorInfo => ({
    message: run.error_message ?? "Erro sem mensagem",
    type: run.error_type,
    traceback: run.error_traceback,
    line: run.error_line,
    column: run.error_column,
    pydanticCode: run.pydantic_code,
  });

  return (
    <div className="mx-auto max-w-4xl space-y-3 p-6">
      {runs.map((run) => {
        const s = stats[run.job_id] ?? { current: 0, partial: 0 };
        const modelLabel =
          run.llm_provider && run.llm_model
            ? formatModelLabel(`${run.llm_provider}/${run.llm_model}`)
            : "—";
        const isOpen = openErrorId === run.id;
        return (
          <Collapsible key={run.id}>
            <div className="rounded-md border">
              <CollapsibleTrigger className="group flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50">
                <ChevronRight className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-90 text-muted-foreground" />
                <StatusBadge status={run.status} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{modelLabel}</div>
                  <div className="text-xs text-muted-foreground">
                    {formatDateTime(run.started_at)} ·{" "}
                    {formatFilterMode(run.filter_mode)} ·{" "}
                    {run.document_count ?? "—"} docs
                  </div>
                </div>
                <div className="flex items-center gap-4 text-xs">
                  {(s.current > 0 || s.partial > 0) && (
                    <>
                      <span className="text-emerald-600">
                        {s.current} completa{s.current !== 1 ? "s" : ""}
                      </span>
                      {s.partial > 0 && (
                        <span className="text-amber-600">
                          {s.partial} parcia{s.partial !== 1 ? "is" : "l"}
                        </span>
                      )}
                    </>
                  )}
                  <span className="text-muted-foreground">
                    {formatDuration(run.started_at, run.completed_at)}
                  </span>
                </div>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="space-y-3 border-t px-4 py-3">
                  <div className="flex flex-wrap items-center gap-3 text-xs">
                    <Link
                      href={`/projects/${projectId}/llm/responses?job=${run.job_id}`}
                      className="inline-flex items-center gap-1 rounded-md border px-2 py-1 hover:bg-muted"
                    >
                      <FileText className="h-3 w-3" /> Ver respostas desta run
                    </Link>
                    {run.status === "error" && (
                      <button
                        onClick={() =>
                          setOpenErrorId(isOpen ? null : run.id)
                        }
                        className="inline-flex items-center gap-1 rounded-md border border-destructive/40 px-2 py-1 text-destructive hover:bg-destructive/5"
                      >
                        {isOpen ? "Ocultar detalhes do erro" : "Ver detalhes do erro"}
                      </button>
                    )}
                  </div>

                  {run.error_message && (
                    <div className="rounded-md bg-muted/50 p-3 text-xs whitespace-pre-wrap">
                      <span className="font-medium">Mensagem: </span>
                      {run.error_message}
                    </div>
                  )}

                  {isOpen && run.status === "error" && (
                    <LlmErrorCard
                      error={errorInfoForRun(run)}
                      onDismiss={() => setOpenErrorId(null)}
                    />
                  )}

                  <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                    <div>
                      <dt className="text-muted-foreground">Iniciado</dt>
                      <dd>{formatDateTime(run.started_at)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Finalizado</dt>
                      <dd>
                        {run.completed_at
                          ? formatDateTime(run.completed_at)
                          : "—"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Progresso</dt>
                      <dd>
                        {run.progress}/{run.total}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Job ID</dt>
                      <dd className="truncate font-mono">{run.job_id}</dd>
                    </div>
                  </dl>
                </div>
              </CollapsibleContent>
            </div>
          </Collapsible>
        );
      })}
    </div>
  );
}
