"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LlmErrorCard } from "./LlmErrorCard";
import { EditFieldDialog } from "./EditFieldDialog";
import { ErrorStatsCards } from "./ErrorStatsCards";
import { ErrorFiltersToolbar } from "./ErrorFiltersToolbar";
import { ErrorDecisionDialog, type PendingErrorDecision } from "./ErrorDecisionDialog";
import type { ErrorDecision } from "@/lib/error-resolution";
import { useLlmErrorFiltering } from "@/hooks/useLlmErrorFiltering";
import {
  resolveError,
  reopenError,
  prepareErrorResolution,
} from "@/actions/stats";
import { regenerateAutoReviewBacklog } from "@/actions/field-reviews";
import { markLlmEquivalent } from "@/actions/equivalences";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { PydanticField, SchemaBaselineIdentity } from "@/lib/types";
import type {
  LlmError,
  ReviewedEntry,
} from "@/lib/llm-error-metrics";

interface LlmInsightsViewProps {
  projectId: string;
  errors: LlmError[];
  reviewedEntries: ReviewedEntry[];
  fields: { name: string; description: string }[];
  schemaEditor?: {
    fields: PydanticField[];
    baseline: SchemaBaselineIdentity;
  };
  isCoordinator?: boolean;
  canResolve?: boolean;
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
  schemaEditor,
  isCoordinator,
  canResolve,
  summary,
}: LlmInsightsViewProps) {
  const { refresh } = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editingField, setEditingField] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [pendingDecision, setPendingDecision] = useState<PendingErrorDecision | null>(null);

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
      // "Aguardando a resposta LLM" saiu na #670: documento sem geração LLM
      // deixou de entrar no backlog, então não há mais pedido em espera para
      // contar — o que sobrava ali era a fila insatisfazível se anunciando como
      // se fosse trabalho em andamento.
      const parts = [
        `${result.queued ?? 0} documento(s) reenfileirado(s)`,
        `${result.processed ?? 0} pedido(s) processado(s)`,
      ];
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
  const { measuredErrorCount, filteredErrorRate, sortedErrors } = filtering;

  const prepareDecision = (error: LlmError, decision: ErrorDecision, selectedHumanId?: string) => {
    if (!canResolve || !error.sourceId) return;
    const choices = error.humanChoices ?? [];
    if (choices.length === 0) {
      toast.error("Não há resposta humana ativa para este campo. Refaça a revisão antes de decidir.");
      return;
    }
    const humanId = selectedHumanId ?? choices.find((c) => c.id === error.chosenResponseId)?.id
      ?? (choices.length === 1 ? choices[0].id : undefined);
    if (!humanId) {
      setPendingDecision({ error, decision, context: null });
      return;
    }
    startTransition(async () => {
      try {
        const result = await prepareErrorResolution({ projectId, documentId: error.documentId,
          fieldName: error.fieldName, llmResponseId: error.llmResponseId,
          humanResponseId: humanId, sourceKind: error.source, sourceId: error.sourceId! });
        if (!result.context) { toast.error(result.error ?? "Não foi possível conferir as respostas."); return; }
        setPendingDecision({ error, decision, context: result.context });
      } catch {
        toast.error("Não foi possível conferir as respostas.");
      }
    });
  };

  const confirmDecision = (note: string) => {
    if (!canResolve || !pendingDecision) return;
    const { error, context, decision } = pendingDecision;
    startTransition(async () => {
      try {
        const result = decision && context
          ? await resolveError(projectId, error.documentId, error.fieldName, {
            decision, context, expected: error.resolution ?? null, note,
          })
          : !decision && error.resolution
            ? await reopenError(projectId, error.documentId, error.fieldName, error.resolution)
            : { success: false, error: "Confira a resposta antes de confirmar." };
        if (!result.success) { toast.error(result.error ?? "Falha ao salvar."); return; }
        toast.success(decision ? "Decisão salva" : "Caso reaberto");
        setPendingDecision(null);
        refresh();
      } catch {
        toast.error("Não foi possível confirmar a gravação. Recarregue antes de tentar novamente.");
      }
    });
  };

  const handleMarkEquivalent = (e: LlmError) => {
    // Mesma fronteira do affordance no card, aqui como fail-closed: gravar
    // `response_equivalences` para um erro de auto-revisão não muda a
    // classificação dele (bdcdo/dataframeitGUI#705).
    if (e.source !== "comparacao") return;
    if (!e.chosenResponseId) return;
    startTransition(async () => {
      const result = await markLlmEquivalent(
        projectId,
        e.documentId,
        e.fieldName,
        e.llmResponseId,
        e.chosenResponseId!,
      );
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Respostas marcadas como equivalentes");
        refresh();
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
        errorCount={measuredErrorCount}
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
          {sortedErrors.map((e) => (
            <LlmErrorCard
              // (documentId, fieldName) é a identidade do erro — é por esse par
              // que resolveError/reopenError o localizam. O índice no fim da
              // chave só mascarava o reorder dos filtros.
              key={`${e.documentId}-${e.fieldName}`}
              error={e}
              projectId={projectId}
              isPending={isPending}
              isCoordinator={isCoordinator}
              canResolve={canResolve}
              onDecide={(decision) => prepareDecision(e, decision)}
              onReopen={() => setPendingDecision({ error: e, decision: null, context: null })}
              onEditField={() => setEditingField(e.fieldName)}
              onMarkEquivalent={() => handleMarkEquivalent(e)}
            />
          ))}
        </div>
      )}
    </div>

    {pendingDecision && (
      <ErrorDecisionDialog
        key={`${pendingDecision.error.documentId}:${pendingDecision.error.fieldName}:${pendingDecision.decision}`}
        pending={pendingDecision} isPending={isPending}
        onClose={() => setPendingDecision(null)}
        onPrepare={(humanId) => { if (pendingDecision.decision) prepareDecision(pendingDecision.error, pendingDecision.decision, humanId); }}
        onConfirm={confirmDecision}
      />
    )}
    {isCoordinator && editingField && schemaEditor && (
      <EditFieldDialog
        projectId={projectId}
        fieldName={editingField}
        allFields={schemaEditor.fields}
        schemaBaseline={schemaEditor.baseline}
        open={!!editingField}
        onOpenChange={(open) => {
          if (!open) setEditingField(null);
        }}
      />
    )}
    </>
  );
}
