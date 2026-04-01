"use client";

import { useOptimistic, useTransition } from "react";
import { toggleAssignment } from "@/actions/assignments";
import { cn } from "@/lib/utils";
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
  type?: "codificacao" | "comparacao";
}

type OptimisticUpdate = { docId: string; userId: string; action: "add" | "remove" };

export function AssignmentTable({ projectId, documents, researchers, assignments, type = "codificacao" }: AssignmentTableProps) {
  const [isPending, startTransition] = useTransition();

  const [optimisticAssignments, setOptimistic] = useOptimistic(
    assignments,
    (current: Assignment[], update: OptimisticUpdate) => {
      if (update.action === "add") {
        return [...current, {
          id: "optimistic",
          project_id: projectId,
          document_id: update.docId,
          user_id: update.userId,
          status: "pendente" as const,
          type,
          batch_id: null,
          deadline: null,
          completed_at: null,
        }];
      }
      return current.filter(
        (a) => !(a.document_id === update.docId && a.user_id === update.userId && a.status === "pendente")
      );
    }
  );

  const assignmentMap = new Map<string, Assignment>();
  for (const a of optimisticAssignments) {
    assignmentMap.set(`${a.document_id}:${a.user_id}`, a);
  }

  const handleToggle = (documentId: string, userId: string) => {
    const existing = assignmentMap.get(`${documentId}:${userId}`);

    // Don't allow removing em_andamento/concluido
    if (existing && existing.status !== "pendente") return;

    const action = existing ? "remove" : "add";

    startTransition(async () => {
      setOptimistic({ docId: documentId, userId, action });
      await toggleAssignment(projectId, documentId, userId, type);
    });
  };

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-3 py-2 text-left font-medium">Documento</th>
              {researchers.map((r) => (
                <th key={r.user_id} className="px-3 py-2 text-center font-medium">
                  {r.profiles?.first_name || r.profiles?.email?.split("@")[0]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {documents.map((doc) => (
              <tr key={doc.id} className="border-b">
                <td className="px-3 py-1.5 font-mono text-xs">{doc.external_id || doc.id.slice(0, 8)}</td>
                {researchers.map((r) => {
                  const assignment = assignmentMap.get(`${doc.id}:${r.user_id}`);
                  const isAssigned = !!assignment;
                  const status = assignment?.status;
                  const deadline = assignment?.deadline;
                  const isOverdue =
                    deadline &&
                    status !== "concluido" &&
                    new Date(deadline + "T00:00:00") < today;

                  const isNonRemovable = status === "concluido" || status === "em_andamento";

                  const cellColor = status === "concluido"
                    ? "bg-green-500 border-green-600"
                    : status === "em_andamento"
                    ? "bg-yellow-400 border-yellow-500"
                    : isAssigned
                    ? "bg-brand border-brand"
                    : "border-muted-foreground/30 hover:border-brand/50";

                  const cell = (
                    <button
                      onClick={() => handleToggle(doc.id, r.user_id)}
                      disabled={isNonRemovable}
                      className={cn(
                        "h-5 w-5 rounded border transition-colors",
                        cellColor,
                        isOverdue && "ring-2 ring-destructive ring-offset-1",
                        isNonRemovable && "cursor-default"
                      )}
                    >
                      {isAssigned && (
                        <span className={cn(
                          "text-xs",
                          status === "concluido" || status === "em_andamento"
                            ? "text-white"
                            : "text-brand-foreground"
                        )}>
                          {status === "concluido" ? "✓" : status === "em_andamento" ? "…" : "✓"}
                        </span>
                      )}
                    </button>
                  );

                  return (
                    <td key={r.user_id} className="px-3 py-1.5 text-center">
                      {deadline ? (
                        <Tooltip>
                          <TooltipTrigger asChild>{cell}</TooltipTrigger>
                          <TooltipContent side="top" className="text-xs">
                            Prazo:{" "}
                            {new Date(deadline + "T00:00:00").toLocaleDateString("pt-BR", {
                              day: "numeric",
                              month: "short",
                            })}
                            {isOverdue && " (atrasado)"}
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
                const count = optimisticAssignments.filter((a) => a.user_id === r.user_id).length;
                const done = optimisticAssignments.filter((a) => a.user_id === r.user_id && a.status === "concluido").length;
                return (
                  <td key={r.user_id} className="px-3 py-1.5 text-center font-medium">
                    <span>{done}/{count}</span>
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>
    </TooltipProvider>
  );
}
