"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LlmErrorCard } from "./LlmErrorCard";
import { EditFieldDialog } from "./EditFieldDialog";
import { ErrorStatsCards } from "./ErrorStatsCards";
import { ErrorFiltersToolbar } from "./ErrorFiltersToolbar";
import { useLlmErrorFiltering } from "@/hooks/useLlmErrorFiltering";
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

export function LlmInsightsView({
  projectId,
  errors,
  reviewedEntries,
  fields,
  allFields,
  isCoordinator,
  summary,
}: LlmInsightsViewProps) {
  const { refresh } = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editingField, setEditingField] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);

  async function handleRegenerateBacklog() {
    setRegenerating(true);
    // try/finally: uma rejeição da action (queda de rede, erro não capturado
    // no servidor) não pode deixar o botão preso em "Regenerando…".
    try {
      const result = await regenerateAutoReviewBacklog(projectId);
      if (!result.success) {
        toast.error(result.error ?? "Falha ao regenerar backlog");
        return;
      }
      const parts = [
        `${result.scanned ?? 0} resposta(s) escaneada(s)`,
        `${result.regenerated ?? 0} doc(s) com divergência`,
      ];
      if (result.removed) {
        parts.push(`${result.removed} revisão(ões) obsoleta(s) removida(s)`);
      }
      if (result.keptResolved) {
        parts.push(`${result.keptResolved} já resolvida(s) mantida(s)`);
      }
      toast.success(`Backlog regenerado. ${parts.join(", ")}.`);
      refresh();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Falha ao regenerar backlog",
      );
    } finally {
      setRegenerating(false);
    }
  }

  // Error filters + derivation (filtered population, rate, sorting, counts)
  const filtering = useLlmErrorFiltering(errors, reviewedEntries);
  const { filteredErrors, filteredErrorRate, sortedErrors } = filtering;

  // Error handlers
  const handleResolveError = (documentId: string, fieldName: string) => {
    startTransition(async () => {
      const result = await resolveError(projectId, documentId, fieldName);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Erro resolvido");
        refresh();
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
        refresh();
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
        refresh();
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
            onClick={() => void handleRegenerateBacklog()}
            disabled={regenerating}
          >
            {regenerating ? "Regenerando…" : "Regenerar backlog"}
          </Button>
        </div>
      ) : null}

      <ErrorStatsCards
        totalLlmDocs={summary.totalLlmDocs}
        errorCount={filteredErrors.length}
        errorRatePct={filteredErrorRate}
        unreviewedLlmDocs={summary.unreviewedLlmDocs}
      />

      <ErrorFiltersToolbar fields={fields} filtering={filtering} />

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
