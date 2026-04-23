"use client";

import Link from "next/link";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { ChevronRight, ExternalLink } from "lucide-react";
import type { LlmResponseRecord } from "@/actions/llm";
import { formatModelLabel } from "@/lib/model-registry";

export type ResponseStatus = "complete" | "partial" | "empty";

export function classifyResponse(r: LlmResponseRecord): ResponseStatus {
  const entries = Object.entries(r.answers ?? {});
  const hasValue = entries.some(([, v]) => {
    if (v == null) return false;
    if (typeof v === "string") return v.trim().length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v).length > 0;
    return true;
  });
  if (!hasValue) return "empty";
  return r.is_partial ? "partial" : "complete";
}

function StatusBadge({ status }: { status: ResponseStatus }) {
  if (status === "complete")
    return (
      <Badge className="bg-emerald-600 hover:bg-emerald-600 text-white">
        Completa
      </Badge>
    );
  if (status === "partial")
    return (
      <Badge className="bg-amber-600 hover:bg-amber-600 text-white">
        Parcial
      </Badge>
    );
  return <Badge variant="destructive">Vazia</Badge>;
}

function formatValue(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "string") return v.trim() === "" ? "—" : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v))
    return v.length === 0 ? "—" : v.map((x) => formatValue(x)).join(", ");
  if (typeof v === "object") return JSON.stringify(v, null, 2);
  return String(v);
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

interface LlmResponseRowProps {
  projectId: string;
  response: LlmResponseRecord;
  fieldLabels: Record<string, string>;
}

export function LlmResponseRow({
  projectId,
  response: r,
  fieldLabels,
}: LlmResponseRowProps) {
  const status = classifyResponse(r);
  const docTitle =
    r.document?.title?.trim() ||
    r.document?.external_id ||
    r.document_id.slice(0, 8);

  const entries = Object.entries(r.answers ?? {});
  const filledCount = entries.filter(([, v]) => {
    if (v == null) return false;
    if (typeof v === "string") return v.trim().length > 0;
    if (Array.isArray(v)) return v.length > 0;
    return true;
  }).length;

  const modelLabel = r.respondent_name
    ? formatModelLabel(r.respondent_name)
    : "—";

  return (
    <Collapsible>
      <div className="rounded-md border">
        <CollapsibleTrigger className="group flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50">
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
          <StatusBadge status={status} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{docTitle}</div>
            <div className="text-xs text-muted-foreground">
              {modelLabel} · {formatDateTime(r.created_at)}
            </div>
          </div>
          <div className="text-xs text-muted-foreground">
            {filledCount}/{entries.length} campo{entries.length !== 1 ? "s" : ""}
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-3 border-t px-4 py-3">
            {entries.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Resposta vazia — o LLM não retornou nenhum campo para este
                documento. Veja a aba Execuções para o motivo.
              </p>
            ) : (
              <dl className="grid gap-2 text-sm">
                {entries.map(([field, value]) => (
                  <div
                    key={field}
                    className="grid grid-cols-[minmax(0,200px)_1fr] gap-3 border-b pb-2 last:border-0"
                  >
                    <dt className="text-xs font-medium text-muted-foreground">
                      {fieldLabels[field] ?? field}
                      {fieldLabels[field] && (
                        <div className="font-mono text-[10px] opacity-60">
                          {field}
                        </div>
                      )}
                    </dt>
                    <dd className="whitespace-pre-wrap break-words">
                      {formatValue(value)}
                    </dd>
                  </div>
                ))}
              </dl>
            )}

            {r.justifications && Object.keys(r.justifications).length > 0 && (
              <details className="rounded-md bg-muted/40 p-2 text-xs">
                <summary className="cursor-pointer font-medium">
                  Justificativas
                </summary>
                <dl className="mt-2 space-y-2">
                  {Object.entries(r.justifications).map(([k, v]) => (
                    <div key={k}>
                      <dt className="font-medium text-muted-foreground">
                        {fieldLabels[k] ?? k}
                      </dt>
                      <dd className="whitespace-pre-wrap">{v}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            )}

            <div className="flex flex-wrap gap-2 pt-1 text-xs">
              {r.document && (
                <Link
                  href={`/projects/${projectId}/analyze/code?doc=${r.document_id}`}
                  className="inline-flex items-center gap-1 rounded-md border px-2 py-1 hover:bg-muted"
                >
                  <ExternalLink className="h-3 w-3" /> Abrir documento
                </Link>
              )}
              {r.llm_job_id && (
                <span className="rounded-md bg-muted px-2 py-1 font-mono">
                  job {r.llm_job_id.slice(0, 8)}
                </span>
              )}
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
