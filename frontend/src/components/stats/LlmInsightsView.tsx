"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LlmErrorCard } from "./LlmErrorCard";
import { EditFieldDialog } from "./EditFieldDialog";
import { ErrorStatsCards } from "./ErrorStatsCards";
import { ErrorFiltersToolbar } from "./ErrorFiltersToolbar";
import { ErrorDecisionDialog, type PendingErrorDecision } from "./ErrorDecisionDialog";
import { LapsedDecisionsNotice } from "./LapsedDecisionsNotice";
import { choosesValue, type ErrorDecision, type ErrorResolutionInput } from "@/lib/error-resolution";
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
  LapsedDecision,
  LlmError,
  ReviewedEntry,
} from "@/lib/llm-error-metrics";

interface LlmInsightsViewProps {
  projectId: string;
  errors: LlmError[];
  reviewedEntries: ReviewedEntry[];
  /** Decisões que saíram da fila por terem perdido a validade. */
  lapsedDecisions?: LapsedDecision[];
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

// Constante de módulo: um `[]` no default criaria array novo a cada render.
const NO_LAPSED_DECISIONS: LapsedDecision[] = [];

async function persistDecision(projectId: string, pending: PendingErrorDecision, note: string, value?: unknown) {
  const { error, decision, context } = pending;
  if (decision && context) {
    return resolveError(projectId, error.documentId, error.fieldName, {
      decision, context, expected: error.resolution ?? null, note,
      // Só as decisões com seletor levam valor: o que o revisor escolheu (#733).
      ...(choosesValue(decision) ? { value: value as ErrorResolutionInput["value"] } : {}),
    });
  }
  if (decision === null && error.resolution) {
    return reopenError(projectId, error.documentId, error.fieldName, error.resolution);
  }
  return { success: false, error: "Confira a resposta antes de confirmar." };
}

export function LlmInsightsView({
  projectId,
  errors,
  reviewedEntries,
  lapsedDecisions = NO_LAPSED_DECISIONS,
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
  const regenerateLabel = regenerating ? "Regenerando…" : "Regenerar backlog";
  const emptyMessage = errors.length === 0 ? "Nenhum erro do LLM encontrado." : "Nenhum erro corresponde aos filtros.";

  // A resposta humana do contexto é escolhida no servidor (#733): a UI só
  // passa a que a arbitragem escolheu, como dica.
  const prepareDecision = (error: LlmError, decision: ErrorDecision) => {
    if (!canResolve || !error.sourceId) return;
    startTransition(async () => {
      try {
        const result = await prepareErrorResolution({ projectId, documentId: error.documentId,
          fieldName: error.fieldName, llmResponseId: error.llmResponseId,
          preferredHumanResponseId: error.chosenResponseId, sourceKind: error.source, sourceId: error.sourceId!, decision });
        if (!result.context) { toast.error(result.error ?? "Não foi possível conferir as respostas."); return; }
        setPendingDecision({ error, decision, context: result.context });
      } catch {
        toast.error("Não foi possível conferir as respostas.");
      }
    });
  };

  const confirmDecision = (note: string, value?: unknown) => {
    if (!canResolve || !pendingDecision) return;
    startTransition(async () => {
      try {
        const result = await persistDecision(projectId, pendingDecision, note, value);
        if (!result.success) { toast.error(result.error ?? "Falha ao salvar."); return; }
        toast.success(pendingDecision.decision ? "Decisão salva" : "Caso reaberto");
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
            {regenerateLabel}
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

      <LapsedDecisionsNotice decisions={lapsedDecisions} />

      {sortedErrors.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          {emptyMessage}
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

    <ErrorDecisionDialog
      pending={pendingDecision} isPending={isPending}
      onClose={() => setPendingDecision(null)}
      onConfirm={confirmDecision}
    />
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
