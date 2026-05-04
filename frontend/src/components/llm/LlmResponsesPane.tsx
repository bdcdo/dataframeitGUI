"use client";

import { useMemo, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { LlmResponseRecord, LlmRunRecord } from "@/actions/llm";
import { formatModelLabel } from "@/lib/model-registry";
import {
  LlmResponseRow,
  classifyResponse,
  type ResponseStatus,
} from "./LlmResponseRow";

type StatusFilter = "all" | ResponseStatus;

interface LlmResponsesPaneProps {
  projectId: string;
  responses: LlmResponseRecord[];
  runs: LlmRunRecord[];
  fieldLabels: Record<string, string>;
  activeJobId: string | null;
}

function formatDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function LlmResponsesPane({
  projectId,
  responses,
  runs,
  fieldLabels,
  activeJobId,
}: LlmResponsesPaneProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");

  const counts = useMemo(() => {
    let complete = 0,
      partial = 0,
      empty = 0;
    for (const r of responses) {
      const s = classifyResponse(r);
      if (s === "complete") complete++;
      else if (s === "partial") partial++;
      else empty++;
    }
    return { complete, partial, empty };
  }, [responses]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return responses.filter((r) => {
      if (statusFilter !== "all" && classifyResponse(r) !== statusFilter)
        return false;
      if (!term) return true;
      const title = (r.document?.title ?? "").toLowerCase();
      const ext = (r.document?.external_id ?? "").toLowerCase();
      return title.includes(term) || ext.includes(term);
    });
  }, [responses, statusFilter, search]);

  const setJobFilter = (jobId: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (jobId === "all") params.delete("job");
    else params.set("job", jobId);
    const qs = params.toString();
    startTransition(() => {
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`);
    });
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <header className="space-y-2">
        <h1 className="text-lg font-medium">Respostas do LLM</h1>
        <p className="text-sm text-muted-foreground">
          {responses.length} resposta{responses.length !== 1 ? "s" : ""}
          {" — "}
          <span className="text-emerald-600">
            {counts.complete} completa{counts.complete !== 1 ? "s" : ""}
          </span>
          , <span className="text-amber-600">
            {counts.partial} parcia{counts.partial !== 1 ? "is" : "l"}
          </span>
          , <span className="text-destructive">
            {counts.empty} vazia{counts.empty !== 1 ? "s" : ""}
          </span>
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2" aria-busy={isPending}>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Execução
            {isPending && <Loader2 className="h-3 w-3 animate-spin" />}
          </label>
          <Select
            value={activeJobId ?? "all"}
            onValueChange={setJobFilter}
            disabled={isPending}
          >
            <SelectTrigger className="h-8 w-64 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas as execuções</SelectItem>
              {runs.map((r) => {
                const model =
                  r.llm_provider && r.llm_model
                    ? formatModelLabel(`${r.llm_provider}/${r.llm_model}`)
                    : "—";
                return (
                  <SelectItem key={r.id} value={r.job_id}>
                    {formatDateShort(r.started_at)} · {model}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">Status</label>
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as StatusFilter)}
          >
            <SelectTrigger className="h-8 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas</SelectItem>
              <SelectItem value="complete">Completas</SelectItem>
              <SelectItem value="partial">Parciais</SelectItem>
              <SelectItem value="empty">Vazias</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por título ou ID externo do documento…"
          className="h-8 max-w-sm text-xs"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
          {responses.length === 0
            ? "Nenhuma resposta LLM registrada para este projeto."
            : "Nenhuma resposta corresponde aos filtros atuais."}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((r) => (
            <LlmResponseRow
              key={r.id}
              projectId={projectId}
              response={r}
              fieldLabels={fieldLabels}
            />
          ))}
        </div>
      )}
    </div>
  );
}
