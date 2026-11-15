"use client";

import { useOptimistic, useState, useTransition } from "react";
import { cycleAssignment } from "@/actions/assignments";
import { planAssignmentCycle } from "@/lib/assignment-cycle";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { SelfComparisonDialog, type SelfComparisonRequest } from "./SelfComparisonDialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Document, ProjectMember, Assignment } from "@/lib/types";

interface AssignmentTableProps {
  projectId: string;
  documents: Pick<Document, "id" | "external_id">[];
  researchers: (ProjectMember & { profiles: { first_name: string | null; email: string } })[];
  assignments: Assignment[];
  readOnly?: boolean;
}

type CellState = {
  cod?: Assignment;
  comp?: Assignment;
};

type OptimisticAction = { docId: string; userId: string };

/**
 * As linhas são sempre as do servidor; `savingKey` marca a célula cujo passo
 * do ciclo só o servidor decide. A codificação criada nasce `concluido` se o
 * pesquisador já codificou o documento (#538), e a promoção a comparação de
 * quem codificou pede a confirmação do coordenador sem gravar nada (#880). A
 * tabela não tem como saber nenhum dos dois: a célula mostra "salvando", sem
 * afirmar "pendente" nem "R", até o `revalidatePath` trazer a linha real
 * (#551), e o rodapé segue contando só linhas reais.
 */
type OptimisticState = { rows: Assignment[]; savingKey: string | null };

const cellKey = (docId: string, userId: string) => `${docId}:${userId}`;

/**
 * Próximo estado após um ciclo na célula, pelo mesmo planner da action. Só a
 * remoção é otimista; criação e promoção marcam a célula como salvando, e a
 * célula travada (ou a autocomparação, que pede confirmação) fica como está.
 */
function cycleOptimistic(
  current: OptimisticState,
  { docId, userId }: OptimisticAction,
): OptimisticState {
  const inCell = (a: Assignment) => a.document_id === docId && a.user_id === userId;
  const step = planAssignmentCycle(current.rows.filter(inCell));
  if (step.kind === "insertCoding" || step.kind === "promote") {
    return { ...current, savingKey: cellKey(docId, userId) };
  }
  if (step.kind === "delete") return { ...current, rows: current.rows.filter((a) => !inCell(a)) };
  return current;
}

const docLabel = (doc: AssignmentTableProps["documents"][number]) =>
  doc.external_id || doc.id.slice(0, 8);
const researcherName = (r: AssignmentTableProps["researchers"][number]) =>
  r.profiles?.first_name || r.profiles?.email?.split("@")[0] || "";

export function AssignmentTable({ projectId, documents, researchers, assignments, readOnly = false }: AssignmentTableProps) {
  const [isPending, startTransition] = useTransition();

  const [{ rows: optimisticAssignments, savingKey }, applyOptimistic] = useOptimistic<
    OptimisticState,
    OptimisticAction
  >({ rows: assignments, savingKey: null }, cycleOptimistic);

  const cellMap = new Map<string, CellState>();
  for (const a of optimisticAssignments) {
    const key = cellKey(a.document_id, a.user_id);
    const entry = cellMap.get(key) || {};
    if (a.type === "codificacao") entry.cod = a;
    else entry.comp = a;
    cellMap.set(key, entry);
  }
  // Um revisor ativo por documento (assignments_one_active_comparacao_per_doc):
  // documento já em comparação não oferece a autocomparação.
  const docsInComparison = new Set(
    optimisticAssignments
      .filter((a) => a.type === "comparacao" && a.status !== "concluido")
      .map((a) => a.document_id),
  );

  // Par em que o passo seguinte daria a comparação a quem codificou o
  // documento: a action não grava e pede a confirmação do coordenador.
  const [selfComparison, setSelfComparison] = useState<SelfComparisonRequest | null>(null);

  const handleCycle = (request: SelfComparisonRequest) => {
    startTransition(async () => {
      applyOptimistic({ docId: request.docId, userId: request.userId });
      const result = await cycleAssignment(projectId, request.docId, request.userId);
      if (result.needsSelfComparisonConfirmation) setSelfComparison(request);
      else if (result.error) toast.error(result.error);
    });
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-3 py-2 text-left font-medium">Documento</th>
              {researchers.map((r) => (
                <th key={r.user_id} className="px-3 py-2 text-center font-medium">
                  {researcherName(r)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {documents.map((doc) => (
              <tr key={doc.id} className="border-b">
                <td className="px-3 py-1.5 font-mono text-xs">{docLabel(doc)}</td>
                {researchers.map((r) => {
                  const key = cellKey(doc.id, r.user_id);
                  const state = cellMap.get(key) || {};
                  const { cod, comp } = state;
                  const hasAny = !!(cod || comp);

                  // Prioridade para status visual: concluído > em_andamento > pendente
                  const statusOrder = { concluido: 3, em_andamento: 2, pendente: 1 } as const;
                  const cellRows = [cod, comp].filter((a): a is Assignment => !!a);
                  const dominant = cellRows
                    .reduce<Assignment | undefined>(
                      (best, a) =>
                        !best ||
                        (statusOrder[a.status] || 0) > (statusOrder[best.status] || 0)
                          ? a
                          : best,
                      undefined,
                    );
                  const status = dominant?.status;
                  // Criação ou promoção em curso: o desfecho ainda é do servidor.
                  const saving = savingKey === key;

                  const isNonRemovable = status === "concluido" || status === "em_andamento";
                  // Codificação entregue ainda aceita a comparação da própria
                  // codificação, mediante confirmação — o mesmo planner da action.
                  const canAddSelfComparison =
                    planAssignmentCycle(cellRows).kind ===
                      "selfComparisonBesideDone" && !docsInComparison.has(doc.id);
                  const isLocked = readOnly || isPending || (isNonRemovable && !canAddSelfComparison);

                  // Cor base pelo status
                  const baseColor = saving
                    ? "border-dashed border-brand text-foreground"
                    : status === "concluido"
                    ? "bg-green-500 border-green-600 text-white"
                    : status === "em_andamento"
                    ? "bg-yellow-400 border-yellow-500 text-white"
                    : cod && !comp
                    ? "bg-brand border-brand text-brand-foreground"
                    : comp && !cod
                    ? "bg-amber-500 border-amber-600 text-white"
                    : cod && comp
                    ? "bg-brand border-brand text-brand-foreground"
                    : "border-muted-foreground/30 hover:border-brand/50";

                  // Badge de tipo (C / R / C·R)
                  const badgeText =
                    cod && comp ? "C·R" : cod || saving ? "C" : comp ? "R" : null;

                  const statusIcon =
                    status === "concluido" ? "✓" : status === "em_andamento" ? "…" : null;

                  const cell = (
                    <button
                      type="button"
                      onClick={() =>
                        handleCycle({
                          docId: doc.id,
                          userId: r.user_id,
                          docLabel: docLabel(doc),
                          researcherName: researcherName(r),
                        })
                      }
                      disabled={isLocked}
                      aria-busy={saving || undefined}
                      className={cn(
                        "relative size-6 rounded border transition-colors",
                        baseColor,
                        isLocked && "cursor-default",
                      )}
                      aria-label={
                        saving
                          ? "Salvando a atribuição…"
                          : !hasAny
                          ? "Atribuir codificação"
                          : canAddSelfComparison
                          ? "Codificação concluída (clique para atribuir a comparação da própria codificação)"
                          : cod && !comp
                          ? "Atribuição de codificação (clique para trocar por comparação)"
                          : comp && !cod
                          ? "Atribuição de comparação (clique para remover)"
                          : "Atribuição de codificação e comparação"
                      }
                    >
                      {statusIcon && (
                        <span className="text-xs leading-none">{statusIcon}</span>
                      )}
                      {badgeText && !statusIcon && (
                        <span className="text-[9px] font-semibold leading-none">
                          {badgeText}
                        </span>
                      )}
                      {badgeText && statusIcon && (
                        <span className="absolute -right-1 -top-1 rounded-sm bg-foreground/80 px-0.5 text-[8px] font-semibold leading-tight text-background">
                          {badgeText}
                        </span>
                      )}
                    </button>
                  );

                  const tooltipParts: string[] = [];
                  if (saving) tooltipParts.push("Codificação (salvando…)");
                  else if (cod) tooltipParts.push(`Codificação (${cod.status})`);
                  if (comp) tooltipParts.push(`Comparação (${comp.status})`);
                  if (comp?.self_comparison_approved_by) tooltipParts.push("Autocomparação liberada pelo coordenador");

                  return (
                    <td key={r.user_id} className="px-3 py-1.5 text-center">
                      {tooltipParts.length > 0 ? (
                        <Tooltip>
                          <TooltipTrigger asChild>{cell}</TooltipTrigger>
                          <TooltipContent side="top" className="text-xs">
                            {tooltipParts.map((p, i) => (
                              <div key={i}>{p}</div>
                            ))}
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        cell
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-muted/30">
              <td className="px-3 py-1.5 font-medium">Total</td>
              {researchers.map((r) => {
                const forUser = optimisticAssignments.filter((a) => a.user_id === r.user_id);
                const codTotal = forUser.filter((a) => a.type === "codificacao").length;
                const codDone = forUser.filter(
                  (a) => a.type === "codificacao" && a.status === "concluido",
                ).length;
                const compTotal = forUser.filter((a) => a.type === "comparacao").length;
                const compDone = forUser.filter(
                  (a) => a.type === "comparacao" && a.status === "concluido",
                ).length;
                return (
                  <td key={r.user_id} className="px-3 py-1.5 text-center text-xs font-medium">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-brand">
                        C: {codDone}/{codTotal}
                      </span>
                      <span className="text-amber-600">
                        R: {compDone}/{compTotal}
                      </span>
                    </div>
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>
      <SelfComparisonDialog
        projectId={projectId}
        request={selfComparison}
        onClose={() => setSelfComparison(null)}
      />
    </TooltipProvider>
  );
}
