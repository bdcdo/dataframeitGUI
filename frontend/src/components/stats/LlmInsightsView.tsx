"use client";

import { useState, useMemo, useTransition, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  Bot,
  AlertTriangle,
} from "lucide-react";
import { LlmErrorCard } from "./LlmErrorCard";
import { EditFieldDialog } from "./EditFieldDialog";
import {
  resolveError,
  reopenError,
} from "@/actions/stats";
import { regenerateAutoReviewBacklog } from "@/actions/field-reviews";
import { markLlmEquivalent } from "@/actions/equivalences";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { PydanticField } from "@/lib/types";
import type {
  LlmError,
  ReviewedEntry,
} from "@/app/(app)/projects/[id]/reviews/llm-insights/page";

interface LlmInsightsViewProps {
  projectId: string;
  errors: LlmError[];
  reviewedEntries: ReviewedEntry[];
  fields: { name: string; description: string }[];
  allFields?: PydanticField[];
  isCoordinator?: boolean;
  summary: {
    totalLlmDocs: number;
    unreviewedLlmDocs?: number;
  };
}

type DatePreset = "all" | "24h" | "7d" | "30d";
type SortBy = "default" | "field" | "document" | "recent";

function presetCutoffMs(preset: DatePreset, now: number): number | null {
  if (preset === "24h") return now - 24 * 3600_000;
  if (preset === "7d") return now - 7 * 24 * 3600_000;
  if (preset === "30d") return now - 30 * 24 * 3600_000;
  return null;
}

function compareSemverDesc(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return db - da;
  }
  return 0;
}

export function LlmInsightsView({
  projectId,
  errors,
  reviewedEntries,
  fields,
  allFields,
  isCoordinator,
  summary,
}: LlmInsightsViewProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editingField, setEditingField] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);

  async function handleRegenerateBacklog() {
    setRegenerating(true);
    const result = await regenerateAutoReviewBacklog(projectId);
    setRegenerating(false);
    if (!result.success) {
      toast.error(result.error ?? "Falha ao regenerar backlog");
      return;
    }
    toast.success(
      `Backlog regenerado. ${result.scanned ?? 0} resposta(s) escaneada(s), ${result.regenerated ?? 0} doc(s) com divergência.`,
    );
    router.refresh();
  }

  // Error filters
  const [errorFieldFilter, setErrorFieldFilter] = useState("all");
  const [errorSearchQuery, setErrorSearchQuery] = useState("");
  const [errorStatusFilter, setErrorStatusFilter] = useState("open");
  const [errorDateFilter, setErrorDateFilter] = useState<DatePreset>("all");
  const [errorSinceDate, setErrorSinceDate] = useState("");
  const [errorVersionFilter, setErrorVersionFilter] = useState("all");
  const [sortBy, setSortBy] = useState<SortBy>("default");

  // Tick the "now" reference once a minute so the "Últimas 24h/7d/30d"
  // cutoff doesn't freeze on long-open pages. State (rather than a raw
  // Date.now() in render) keeps the component pure per React rules.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Derived from the full reviewed population so a version with 0 errors is
  // still selectable — useful for "0% rate" sanity checks.
  const availableVersions = useMemo(() => {
    const set = new Set<string>();
    for (const r of reviewedEntries) if (r.schemaVersion) set.add(r.schemaVersion);
    return [...set].sort(compareSemverDesc);
  }, [reviewedEntries]);

  // Derive the effective version filter: if the selected version is no
  // longer present (status filter toggled, all errors of that version
  // resolved, etc.) treat it as "all" instead of letting the stale value
  // zero out the list with no UI to fix it. Derivation in render avoids
  // a setState-in-effect cascade.
  const effectiveVersionFilter = availableVersions.includes(errorVersionFilter)
    ? errorVersionFilter
    : "all";

  const sinceMs = errorSinceDate
    ? new Date(errorSinceDate + "T00:00:00").getTime()
    : presetCutoffMs(errorDateFilter, now);

  // Scope filters affect both numerator and denominator (so the rate matches
  // the population the user is looking at). Status only affects which errors
  // the user wants to see in the list and in the card.
  const matchesScopeFilters = (e: {
    fieldName: string;
    documentTitle: string;
    reviewedAt: string;
    schemaVersion: string | null;
  }): boolean => {
    if (errorFieldFilter !== "all" && e.fieldName !== errorFieldFilter)
      return false;
    if (
      errorSearchQuery &&
      !e.documentTitle
        .toLowerCase()
        .includes(errorSearchQuery.toLowerCase())
    )
      return false;
    if (sinceMs && new Date(e.reviewedAt).getTime() < sinceMs) return false;
    if (
      effectiveVersionFilter !== "all" &&
      e.schemaVersion !== effectiveVersionFilter
    )
      return false;
    return true;
  };

  const filteredReviewed = reviewedEntries.filter(matchesScopeFilters);

  const filteredErrors = errors.filter((e) => {
    if (errorStatusFilter === "open" && e.resolvedAt) return false;
    if (errorStatusFilter === "resolved" && !e.resolvedAt) return false;
    return matchesScopeFilters(e);
  });

  // Rate uses the same numerator shown in the card (so the two are always
  // consistent) over the scope-filtered reviewed population.
  const filteredErrorRate =
    filteredReviewed.length > 0
      ? Math.round((filteredErrors.length / filteredReviewed.length) * 100)
      : 0;

  const sortedErrors = (() => {
    if (sortBy === "default") return filteredErrors;
    const arr = [...filteredErrors];
    if (sortBy === "field") {
      arr.sort((a, b) => {
        const fa = a.fieldDescription.localeCompare(b.fieldDescription, "pt-BR");
        if (fa !== 0) return fa;
        return a.documentTitle.localeCompare(b.documentTitle, "pt-BR");
      });
    } else if (sortBy === "document") {
      arr.sort((a, b) =>
        a.documentTitle.localeCompare(b.documentTitle, "pt-BR"),
      );
    } else if (sortBy === "recent") {
      arr.sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt));
    }
    return arr;
  })();

  // Counted within the current scope so the badge matches the cards.
  const openErrorCount = errors.filter(
    (e) => !e.resolvedAt && matchesScopeFilters(e),
  ).length;

  // Error handlers
  const handleResolveError = (documentId: string, fieldName: string) => {
    startTransition(async () => {
      const result = await resolveError(projectId, documentId, fieldName);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Erro resolvido");
        router.refresh();
      }
    });
  };

  const handleReopenError = (documentId: string, fieldName: string) => {
    startTransition(async () => {
      const result = await reopenError(projectId, documentId, fieldName);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Erro reaberto");
        router.refresh();
      }
    });
  };

  const handleMarkEquivalent = (e: LlmError) => {
    if (!e.chosenResponseId) return;
    startTransition(async () => {
      try {
        await markLlmEquivalent(
          projectId,
          e.documentId,
          e.fieldName,
          e.llmResponseId,
          e.chosenResponseId!,
        );
        toast.success("Respostas marcadas como equivalentes");
        router.refresh();
      } catch (err) {
        toast.error((err as Error).message);
      }
    });
  };

  return (
    <>
    <div className="space-y-4">
      {isCoordinator ? (
        <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 p-3">
          <div>
            <p className="text-sm font-medium">Backlog de auto-revisão</p>
            <p className="text-xs text-muted-foreground">
              Varre todas as codificações humanas concluídas e cria entradas de
              auto-revisão para divergências com o LLM. Idempotente.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRegenerateBacklog}
            disabled={regenerating}
          >
            {regenerating ? "Regenerando…" : "Regenerar backlog"}
          </Button>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="flex items-center gap-3 pt-6">
            <Bot className="h-5 w-5 text-brand" />
            <div>
              <p className="text-2xl font-bold tabular-nums">
                {summary.totalLlmDocs}
              </p>
              <p className="text-xs text-muted-foreground">
                Docs com LLM
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 pt-6">
            <AlertTriangle className="h-5 w-5 text-red-500" />
            <div>
              <p className="text-2xl font-bold tabular-nums">
                {filteredErrors.length}
              </p>
              <p className="text-xs text-muted-foreground">
                Campos incorretos
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 text-center">
            <p className="text-2xl font-bold tabular-nums">
              {filteredErrorRate}%
            </p>
            <p className="text-xs text-muted-foreground">Taxa de erro</p>
          </CardContent>
        </Card>
      </div>

      {!!summary.unreviewedLlmDocs && summary.unreviewedLlmDocs > 0 && (
        <p className="text-xs text-muted-foreground text-center">
          {summary.unreviewedLlmDocs} documento{summary.unreviewedLlmDocs !== 1 ? "s" : ""} com respostas do LLM ainda não {summary.unreviewedLlmDocs !== 1 ? "foram revisados" : "foi revisado"}.
          Erros só aparecem após a revisão humana.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Buscar documento..."
          value={errorSearchQuery}
          onChange={(e) => setErrorSearchQuery(e.target.value)}
          className="w-56"
        />
        <Select value={errorFieldFilter} onValueChange={setErrorFieldFilter}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Campo" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os campos</SelectItem>
            {fields.map((f) => (
              <SelectItem key={f.name} value={f.name}>
                {f.description || f.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={errorStatusFilter} onValueChange={setErrorStatusFilter}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Abertos</SelectItem>
            <SelectItem value="resolved">Resolvidos</SelectItem>
            <SelectItem value="all">Todos</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={errorDateFilter}
          onValueChange={(v) => {
            setErrorDateFilter(v as DatePreset);
            setErrorSinceDate("");
          }}
        >
          <SelectTrigger className="w-36" title="Data de criação da revisão">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Qualquer data</SelectItem>
            <SelectItem value="24h">Últimas 24h</SelectItem>
            <SelectItem value="7d">Últimos 7 dias</SelectItem>
            <SelectItem value="30d">Últimos 30 dias</SelectItem>
          </SelectContent>
        </Select>
        <Input
          type="date"
          value={errorSinceDate}
          onChange={(e) => {
            setErrorSinceDate(e.target.value);
            if (e.target.value) setErrorDateFilter("all");
          }}
          className="w-40"
          title="Apenas revisões criadas a partir desta data"
        />
        {availableVersions.length > 0 && (
          <Select
            value={effectiveVersionFilter}
            onValueChange={setErrorVersionFilter}
          >
            <SelectTrigger className="w-36" title="Versão do schema">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas as versões</SelectItem>
              {availableVersions.map((v) => (
                <SelectItem key={v} value={v}>
                  v{v}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortBy)}>
          <SelectTrigger className="w-44" title="Ordenar por">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">Ordem padrão</SelectItem>
            <SelectItem value="field">Por pergunta (A→Z)</SelectItem>
            <SelectItem value="document">Por documento (A→Z)</SelectItem>
            <SelectItem value="recent">Mais recentes primeiro</SelectItem>
          </SelectContent>
        </Select>
        <span className="ml-auto text-sm text-muted-foreground">
          {sortedErrors.length} erro{sortedErrors.length !== 1 ? "s" : ""}
          {openErrorCount > 0 && (
            <Badge variant="destructive" className="ml-1.5">
              {openErrorCount} aberto{openErrorCount !== 1 ? "s" : ""}
            </Badge>
          )}
        </span>
      </div>

      {sortedErrors.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          {errors.length === 0
            ? "Nenhum erro do LLM encontrado."
            : "Nenhum erro corresponde aos filtros."}
        </p>
      ) : (
        <div className="space-y-3">
          {sortedErrors.map((e, i) => (
            <LlmErrorCard
              key={`${e.documentId}-${e.fieldName}-${i}`}
              error={e}
              projectId={projectId}
              isPending={isPending}
              isCoordinator={isCoordinator}
              onResolve={() => handleResolveError(e.documentId, e.fieldName)}
              onReopen={() => handleReopenError(e.documentId, e.fieldName)}
              onEditField={() => setEditingField(e.fieldName)}
              onMarkEquivalent={() => handleMarkEquivalent(e)}
            />
          ))}
        </div>
      )}
    </div>

    {isCoordinator && editingField && allFields && (
      <EditFieldDialog
        projectId={projectId}
        fieldName={editingField}
        allFields={allFields}
        open={!!editingField}
        onOpenChange={(open) => {
          if (!open) setEditingField(null);
        }}
      />
    )}
    </>
  );
}
